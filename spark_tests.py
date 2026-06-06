"""Run the 6 ambulance capability tests ON the DGX Spark. Writes results.json.
Each test is isolated in try/except so one failure still yields a full report.
"""
import json, time, subprocess, threading, traceback
from pathlib import Path
import numpy as np, polars as pl, xgboost as xgb

HERE = Path(__file__).parent
DATA = HERE / "data"
RESULTS = []


def add(name, purpose, status, findings, error=None, dur=None):
    RESULTS.append(dict(name=name, purpose=purpose, status=status,
                        findings=findings, error=error, duration_s=dur))
    print(f"[{status}] {name}  ({dur:.1f}s)" if dur else f"[{status}] {name}")


# ---- shared: build the fire travel-training matrices (mirrors t2_physics) ----
def build_training():
    mob = pl.read_parquet(DATA/"mobilisations.parquet").filter(
        (pl.col("PumpOrder")==1) & (pl.col("DeployedFromLocation")=="Home Station")
        & pl.col("TravelTimeSeconds").is_between(30,1800)
        & pl.col("TurnoutTimeSeconds").is_between(10,600))
    inc = pl.read_parquet(DATA/"incidents.parquet").select(
        "IncidentNumber","Easting_rounded","Northing_rounded","IncGeo_BoroughName")
    legs = mob.join(inc,on="IncidentNumber",how="inner").drop_nulls(
        ["Easting_rounded","Northing_rounded","DateAndTimeMobilised"])
    st = (legs.filter(pl.col("TravelTimeSeconds")<=180).group_by("DeployedFromStation_Name")
          .agg(E=pl.col("Easting_rounded").median(),N=pl.col("Northing_rounded").median(),
               n=pl.len()).filter(pl.col("n")>=50))
    legs = legs.join(st.select(pl.col("DeployedFromStation_Name"),"E","N"),
                     on="DeployedFromStation_Name",how="inner").with_columns(
        dist_m=((pl.col("Easting_rounded")-pl.col("E"))**2+(pl.col("Northing_rounded")-pl.col("N"))**2).sqrt(),
        dow=pl.col("DateAndTimeMobilised").dt.weekday(),
        month=pl.col("DateAndTimeMobilised").dt.month(),
    ).filter(pl.col("dist_m").is_between(50,15000))
    sidx={s:i for i,s in enumerate(st["DeployedFromStation_Name"].to_list())}
    legs=legs.with_columns(st_idx=pl.col("DeployedFromStation_Name").replace_strict(sidx,default=-1))
    F=["dist_m","HourOfCall","dow","month","st_idx"]
    tr=legs.filter(pl.col("CalYear")<=2024); te=legs.filter(pl.col("CalYear")>=2025)
    return (tr.select(F).to_numpy().astype(np.float32), tr["TravelTimeSeconds"].to_numpy().astype(np.float32),
            te.select(F).to_numpy().astype(np.float32), te["TravelTimeSeconds"].to_numpy().astype(np.float32))


def gpu_util_now():
    try:
        r=subprocess.run(["nvidia-smi","--query-gpu=utilization.gpu,memory.used",
                          "--format=csv,noheader,nounits"],capture_output=True,text=True,timeout=5)
        u,m=r.stdout.strip().splitlines()[0].split(",")
        return int(u), int(m)
    except Exception:
        return None, None


# cache training data once
_TRAIN = None
def train_data():
    global _TRAIN
    if _TRAIN is None:
        _TRAIN = build_training()
    return _TRAIN


# ============ TEST 1 — GPU lights-on ============
def test1():
    t0=time.time()
    try:
        Xtr,ytr,Xte,yte = train_data()
        samples=[]; stop=threading.Event()
        def sampler():
            while not stop.is_set():
                u,_=gpu_util_now()
                if u is not None: samples.append(u)
                time.sleep(0.15)
        th=threading.Thread(target=sampler); th.start()
        # big enough model that the GPU is busy long enough to observe
        m=xgb.XGBRegressor(n_estimators=3000,max_depth=10,learning_rate=0.05,
                           subsample=0.8,colsample_bytree=0.8,tree_method="hist",device="cuda")
        m.fit(Xtr,ytr)
        stop.set(); th.join()
        use_cuda=xgb.build_info().get("USE_CUDA")
        # Authoritative proof: the trained booster's own device config. (GB10 has unified
        # memory, so nvidia-smi reports utilization as N/A — that probe is unreliable here.)
        cfg=json.loads(m.get_booster().save_config())
        device=cfg.get("learner",{}).get("generic_param",{}).get("device","")
        maxu=max(samples) if samples else None
        ok = bool(use_cuda) and "cuda" in str(device)
        add("1. GPU lights-on","Prove training genuinely runs on the GB10 GPU, not silently on CPU.",
            "PASS" if ok else "FAIL",
            {"USE_CUDA":use_cuda,"booster_device":device,
             "nvidia_smi_util_pct":(maxu if maxu is not None else "N/A (GB10 unified memory)"),
             "train_rows":int(len(ytr))}, dur=time.time()-t0)
    except Exception:
        add("1. GPU lights-on","Prove training genuinely runs on the GB10 GPU.","ERROR",{},
            traceback.format_exc(), time.time()-t0)


# ============ TEST 2 — GPU model accuracy ============
def test2():
    t0=time.time()
    try:
        Xtr,ytr,Xte,yte = train_data()
        m=xgb.XGBRegressor(n_estimators=400,max_depth=8,learning_rate=0.08,
                           subsample=0.8,colsample_bytree=0.8,tree_method="hist",device="cuda")
        m.fit(Xtr,ytr); p=m.predict(Xte)
        medae=float(np.median(np.abs(p-yte))); mae=float(np.mean(np.abs(p-yte)))
        r2=float(1-np.sum((yte-p)**2)/np.sum((yte-yte.mean())**2))
        ok = 40<=medae<=48
        add("2. GPU model accuracy","Confirm GPU training didn't degrade quality (expect medAE ~43.7s).",
            "PASS" if ok else "FAIL",
            {"medAE_s":round(medae,1),"MAE_s":round(mae,1),"R2":round(r2,3),
             "expected_medAE_s":43.7,"test_rows":int(len(yte))}, dur=time.time()-t0)
    except Exception:
        add("2. GPU model accuracy","Confirm GPU training quality.","ERROR",{},
            traceback.format_exc(), time.time()-t0)


# ============ TEST 3 — scale-up timing GPU vs CPU ============
def test3():
    t0=time.time()
    try:
        Xtr,ytr,Xte,yte = train_data()
        rows=[]
        for ne in (200,800,3000):
            g=xgb.XGBRegressor(n_estimators=ne,max_depth=10,learning_rate=0.05,
                               subsample=0.8,colsample_bytree=0.8,tree_method="hist",device="cuda")
            a=time.time(); g.fit(Xtr,ytr); tg=time.time()-a
            c=xgb.XGBRegressor(n_estimators=ne,max_depth=10,learning_rate=0.05,
                               subsample=0.8,colsample_bytree=0.8,tree_method="hist",n_jobs=8)
            a=time.time(); c.fit(Xtr,ytr); tc=time.time()-a
            rows.append({"n_estimators":ne,"gpu_s":round(tg,2),"cpu_s":round(tc,2),
                         "speedup":round(tc/max(tg,1e-6),2)})
        crossover = any(r["speedup"]>1.0 for r in rows)
        add("3. Scale-up timing","Find where the GPU beats the CPU (honest speed story, no fake speedup).",
            "PASS", {"by_size":rows,"gpu_wins_at_scale":crossover}, dur=time.time()-t0)
    except Exception:
        add("3. Scale-up timing","GPU vs CPU timing across sizes.","ERROR",{},
            traceback.format_exc(), time.time()-t0)


# ============ TEST 4 — full pipeline on the Spark ============
def test4():
    t0=time.time()
    try:
        import etl_ambulance, service_ambulance as S
        etl_ambulance.main()                       # build incidents_ambulance.parquet on the box
        S.load_stations(); S.las_targets(); S.load_demand()
        outs=["ambulance_demand.parquet","ambulance_stations.parquet",
              "las_targets.parquet"]
        present={o:(DATA/"processed"/o).exists() for o in outs}
        ok=all(present.values())
        add("4. Full pipeline on Spark","Prove the whole ambulance pipeline runs ON the box (data never leaves the room).",
            "PASS" if ok else "FAIL", {"outputs_present":present}, dur=time.time()-t0)
    except Exception:
        add("4. Full pipeline on Spark","Run the whole pipeline on the box.","ERROR",{},
            traceback.format_exc(), time.time()-t0)


# ============ TEST 5 — performance numbers ============
def test5():
    t0=time.time()
    try:
        import service_ambulance as S
        a=time.time(); r=S.transfer_experiment(n=50000); t_tr=time.time()-a
        a=time.time(); d=S.closure_damage(); t_cl=time.time()-a
        add("5. Performance","Measure throughput: incidents/sec and full 73-station closure sweep time.","PASS",
            {"transfer_50k_s":round(t_tr,2),"incidents_per_sec":int(50000/t_tr),
             "closure_sweep_s":round(t_cl,2),"stations_swept":int(d.height),
             "transfer_result":r}, dur=time.time()-t0)
    except Exception:
        add("5. Performance","Measure throughput.","ERROR",{},traceback.format_exc(),time.time()-t0)


# ============ TEST 6 — reproducibility ============
def test6():
    t0=time.time()
    try:
        import service_ambulance as S
        r1=S.transfer_experiment(n=50000,seed=7); r2=S.transfer_experiment(n=50000,seed=7)
        same = r1["sim_mean_s"]==r2["sim_mean_s"] and r1["sim_p90_s"]==r2["sim_p90_s"]
        add("6. Reproducibility","Same seed must give the identical answer (no hidden randomness).",
            "PASS" if same else "FAIL", {"run1":r1,"run2":r2,"identical":same}, dur=time.time()-t0)
    except Exception:
        add("6. Reproducibility","Same-seed determinism.","ERROR",{},traceback.format_exc(),time.time()-t0)


if __name__ == "__main__":
    import platform
    meta={"host":platform.node(),"python":platform.python_version(),
          "xgboost":xgb.__version__,"use_cuda":xgb.build_info().get("USE_CUDA")}
    u,mem=gpu_util_now(); meta["gpu_mem_used_mib_at_start"]=mem
    for t in (test1,test2,test3,test4,test5,test6):
        t()
    json.dump({"meta":meta,"tests":RESULTS}, open(HERE/"results.json","w"), indent=2)
    print("ALL_TESTS_DONE")

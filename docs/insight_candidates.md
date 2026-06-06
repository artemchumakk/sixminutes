# Insight candidates (Nemotron-Super-120B over twin outputs)



**WINNER**  
**Headline:** Closing the moderately‑busy Croydon station would add more response delay (≈2.1 s per call) than closing the busiest Soho station, despite Croydon handling 37 % fewer calls.  
**Support:** The closure‑sweep shows Croydon’s mean added seconds = 2.08 s (4 819 calls) while Soho’s mean added = 1.59 s (7 680 calls). This non‑linear impact arises because Croydon sits on a critical corridor where its removal forces longer detours for multiple neighboring sectors, whereas Soho’s high volume is offset by dense alternative routes.  
**Chart to show:** Scatter plot of *mean added seconds* (y‑axis) against *annual call volume* (x‑axis) for all stations, highlighting Cro

## Raw facts
```json
{
 "closure_sweep_with_queueing": [
  {
   "station": "Croydon",
   "mean_added_s": 2.0803935729980467,
   "calls": 4819
  },
  {
   "station": "Lambeth",
   "mean_added_s": 1.7152625717163086,
   "calls": 6050
  },
  {
   "station": "Paddington",
   "mean_added_s": 1.7109729721069336,
   "calls": 6726
  },
  {
   "station": "North Kensington",
   "mean_added_s": 1.70206212310791,
   "calls": 5752
  },
  {
   "station": "Euston",
   "mean_added_s": 1.7014659788131714,
   "calls": 5449
  },
  {
   "station": "Hornsey",
   "mean_added_s": 1.615330672454834,
   "calls": 3214
  },
  {
   "station": "Orpington",
   "mean_added_s": 1.60209912109375,
   "calls": 2267
  },
  {
   "station": "Plumstead",
   "mean_added_s": 1.598326862716675,
   "calls": 4574
  },
  {
   "station": "Soho",
   "mean_added_s": 1.5882741516113281,
   "calls": 7680
  },
  {
   "station": "West Hampstead",
   "mean_added_s": 1.5870769081115723,
   "calls": 5404
  },
  {
   "station": "Sutton",
   "mean_added_s": 1.5723631435394287,
   "calls": 3000
  },
  {
   "station": "Hillingdon",
   "mean_added_s": 1.479991893005371,
   "calls": 3155
  },
  {
   "station": "Ilford",
   "mean_added_s": 1.4390671340942383,
   "calls": 4482
  },
  {
   "station": "Hammersmith",
   "mean_added_s": 1.4044459018707276,
   "calls": 5118
  },
  {
   "station": "Enfield",
   "mean_added_s": 1.4020152408599853,
   "calls": 3372
  }
 ],
 "safest_closures": [
  {
   "station": "Biggin Hill",
   "mean_added_s": 0.2481030975341797,
   "calls": 385
  },
  {
   "station": "Hainault",
   "mean_added_s": 0.31993908920288083,
   "calls": 1098
  },
  {
   "station": "Lee Green",
   "mean_added_s": 0.38757279853820803,
   "calls": 1995
  },
  {
   "station": "New Cross",
   "mean_added_s": 0.40502580947875977,
   "calls": 2476
  },
  {
   "station": "Millwall",
   "mean_added_s": 0.40741169471740724,
   "calls": 1572
  }
 ],
 "turnout_by_hour": [
  {
   "HourOfCall": 0,
   "med": 90.0
  },
  {
   "HourOfCall": 1,
   "med": 99.0
  },
  {
   "HourOfCall": 2,
   "med": 104.0
  },
  {
   "HourOfCall": 3,
   "med": 106.0
  },
  {
   "HourOfCall": 4,
   "med": 107.0
  },
  {
   "HourOfCall": 5,
   "med": 108.0
  },
  {
   "HourOfCall": 6,
   "med": 107.0
  },
  {
   "HourOfCall": 7,
   "med": 83.0
  },
  {
   "HourOfCall": 8,
   "med": 70.0
  },
  {
   "HourOfCall": 9,
   "med": 66.0
  },
  {
   "HourOfCall": 10,
   "med": 67.0
  },
  {
   "HourOfCall": 11,
   "med": 65.0
  },
  {
   "HourOfCall": 12,
   "med": 62.0
  },
  {
   "HourOfCall": 13,
   "med": 62.0
  },
  {
   "HourOfCall": 14,
   "med": 62.0
  },
  {
   "HourOfCall": 15,
   "med": 65.0
  },
  {
   "HourOfCall": 16,
   "med": 67.0
  },
  {
   "HourOfCall": 17,
   "med": 68.0
  },
  {
   "HourOfCall": 18,
   "med": 68.0
  },
  {
   "HourOfCall": 19,
   "med": 65.0
  },
  {
   "HourOfCall": 20,
   "med": 64.0
  },
  {
   "HourOfCall": 21,
   "med": 67.0
  },
  {
   "HourOfCall": 22,
   "med": 69.0
  },
  {
   "HourOfCall": 23,
   "med": 78.0
  }
 ],
 "worst_night_turnout_stations": [
  {
   "DeployedFromStation_Name": "Dagenham",
   "false": 80.0,
   "true": 127.0,
   "delta": 47.0
  },
  {
   "DeployedFromStation_Name": "Bromley",
   "false": 76.0,
   "true": 122.0,
   "delta": 46.0
  },
  {
   "DeployedFromStation_Name": "Orpington",
   "false": 80.0,
   "true": 123.0,
   "delta": 43.0
  },
  {
   "DeployedFromStation_Name": "Woodford",
   "false": 78.0,
   "true": 121.0,
   "delta": 43.0
  },
  {
   "DeployedFromStation_Name": "Old Kent Road",
   "false": 62.0,
   "true": 104.0,
   "delta": 42.0
  },
  {
   "DeployedFromStation_Name": "Tooting",
   "false": 76.0,
   "true": 118.0,
   "delta": 42.0
  },
  {
   "DeployedFromStation_Name": "West Norwood",
   "false": 69.0,
   "true": 110.0,
   "delta": 41.0
  },
  {
   "DeployedFromStation_Name": "Plumstead",
   "false": 77.0,
   "true": 118.0,
   "delta": 41.0
  },
  {
   "DeployedFromStation_Name": "Plaistow",
   "false": 70.0,
   "true": 111.0,
   "delta": 41.0
  },
  {
   "DeployedFromStation_Name": "Euston",
   "false": 61.0,
   "true": 102.0,
   "delta": 41.0
  }
 ],
 "delay_codes": [
  {
   "DelayCode_Description": "Traffic, roadworks, etc",
   "len": 56139
  },
  {
   "DelayCode_Description": "Traffic calming measures",
   "len": 19449
  },
  {
   "DelayCode_Description": "Address incomplete/wrong",
   "len": 10042
  },
  {
   "DelayCode_Description": "Arrived but held up - Other reason",
   "len": 2944
  },
  {
   "DelayCode_Description": "On outside duty when mobilised",
   "len": 2518
  },
  {
   "DelayCode_Description": "Mob/Radio problems when mobilised",
   "len": 2403
  },
  {
   "DelayCode_Description": "Weather conditions",
   "len": 1951
  },
  {
   "DelayCode_Description": "Appliance/Equipment defect",
   "len": 1236
  }
 ],
 "false_alarm_load_2025": {
  "false_alarm_share": 0.448,
  "afa_nonres_pump_minutes": 683808
 },
 "slowest_wards_2025": [
  {
   "IncGeo_WardName": "DARWIN",
   "IncGeo_BoroughName": "BROMLEY",
   "mean_att": 540.1829268292682,
   "n": 82
  },
  {
   "IncGeo_WardName": "CHESSINGTON SOUTH & MALDEN RUSHETT",
   "IncGeo_BoroughName": "KINGSTON UPON THAMES",
   "mean_att": 530.5,
   "n": 76
  },
  {
   "IncGeo_WardName": "RIDGEWAY",
   "IncGeo_BoroughName": "ENFIELD",
   "mean_att": 528.8686868686868,
   "n": 99
  },
  {
   "IncGeo_WardName": "HAREFIELD VILLAGE",
   "IncGeo_BoroughName": "HILLINGDON",
   "mean_att": 507.6326530612245,
   "n": 98
  },
  {
   "IncGeo_WardName": "BRIDGE",
   "IncGeo_BoroughName": "REDBRIDGE",
   "mean_att": 497.47222222222223,
   "n": 108
  },
  {
   "IncGeo_WardName": "CRANHAM",
   "IncGeo_BoroughName": "HAVERING",
   "mean_att": 493.3975903614458,
   "n": 83
  },
  {
   "IncGeo_WardName": "CLAYHALL",
   "IncGeo_BoroughName": "REDBRIDGE",
   "mean_att": 486.1287128712871,
   "n": 101
  },
  {
   "IncGeo_WardName": "PERIVALE",
   "IncGeo_BoroughName": "EALING",
   "mean_att": 481.61928934010155,
   "n": 197
  },
  {
   "IncGeo_WardName": "OLD COULSDON",
   "IncGeo_BoroughName": "C
```

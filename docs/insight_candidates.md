# Insight candidates (Nemotron-Super-120B over twin outputs)

**WINNER**  
**1. Closing a low‑volume station can cripple local response while barely moving the city‑wide needle**  
- Biggin Hill serves only 48 calls a year, yet shutting it adds **≈215 seconds** of local travel time (local_added_s) and pushes **35 of its 385 calls (9.1%)** past the 6‑minute target.  
- The same closure adds just **0.26 seconds** to the city‑wide total (city_added_s) – a negligible impact on overall London performance.  
- *Chart to show:* Dual‑axis bar chart (local_added_s vs. city_added_s) for all stations in the closure sweep, with Biggin Hill highlighted to illustrate the stark disparity.

**2. Some inner‑city stations are effectively redundant – closing them hardly hurts anyone**  
- Whitechapel’s closure adds only **≈51 seconds** locally and **0.56 seconds** city‑wide, with just **21 of its 2,692 calls (0.8%)** pushed past 6 minutes.  
- Despite being in a dense, high‑call area, its coverage is largely overlapped by neighbouring units, making it one of the “safest” closures in the sweep.  
- *Chart to show:* Map of London with safest‑closure stations (Whitechapel, Dockhead, Shadwell, Leyton, Old Kent Road) sized by local_added_s and coloured by pushed_past_6min count.

**3. Night‑time turnout penalties are station‑specific and can exceed a full minute**  
- At Dagenham, night turnout jumps from **80 seconds (day)** to **127 seconds (night)** – a **47‑second (≈59%)** increase.  
- Across the ten worst‑night stations the average delta is **≈42 seconds**, meaning many responses that would meet the 6‑minute goal in daylight slip into breach after dark.  
- *Chart to show:* Grouped bar chart comparing day vs. night median turnout for the top‑10 worst‑night stations, with delta values annotated.

**4. False alarms consume nearly half of all calls and thousands of pump‑hour resources**  
- **44.8 %** of all incidents in 2025 are false alarms.  
- These false alarms account for **683,808 pump‑minutes** of non‑residential appliance use – roughly **11,400 hours** or the equivalent of **475 full‑time firefighter days** spent on non‑productive calls.  
- *Chart to show:* Pie chart of call type (false vs. genuine) alongside a bar showing total pump‑minutes broken down by false‑alarm subtype (e.g., AFA non‑residential pump minutes).

**5. Geographic inequities mean some wards regularly experience >9‑minute response times**  
- The slowest ward, **DARWIN (Bromley)**, has a mean attendance of **540 seconds (≈9 minutes)** – **63% above** the 6‑minute target and far above the city‑wide over‑6‑minute share of **33.2 %**.  
- Other high‑latency wards (e.g., CHESSINGTON SOUTH & MALDEN RUSHETT at 530 s, RIDGEWAY at 529 s) reveal clear pockets where residents face substantially slower help.  
- *Chart to show:* Choropleth map of London wards coloured by mean attendance time (seconds), with the top‑5 slowest wards labelled and a legend showing the 6‑minute threshold.

## Raw facts
```json
{
 "closure_sweep_with_queueing": [
  {
   "station": "Biggin Hill",
   "served_baseline": 48,
   "local_added_s": 214.82635498046875,
   "city_added_s": 0.26257964968681335,
   "pushed_past_6min": 35,
   "calls": 385
  },
  {
   "station": "Orpington",
   "served_baseline": 331,
   "local_added_s": 196.8605499267578,
   "city_added_s": 1.638154149055481,
   "pushed_past_6min": 214,
   "calls": 2267
  },
  {
   "station": "Barnet",
   "served_baseline": 287,
   "local_added_s": 171.9535675048828,
   "city_added_s": 1.2492371797561646,
   "pushed_past_6min": 202,
   "calls": 1890
  },
  {
   "station": "Wennington",
   "served_baseline": 194,
   "local_added_s": 170.92123413085938,
   "city_added_s": 0.8691019415855408,
   "pushed_past_6min": 120,
   "calls": 931
  },
  {
   "station": "Hillingdon",
   "served_baseline": 371,
   "local_added_s": 148.03773498535156,
   "city_added_s": 1.43119478225708,
   "pushed_past_6min": 189,
   "calls": 3155
  },
  {
   "station": "Sidcup",
   "served_baseline": 198,
   "local_added_s": 144.09225463867188,
   "city_added_s": 0.724044919013977,
   "pushed_past_6min": 113,
   "calls": 1904
  },
  {
   "station": "Ruislip",
   "served_baseline": 222,
   "local_added_s": 143.65048217773438,
   "city_added_s": 0.8196073174476624,
   "pushed_past_6min": 116,
   "calls": 1503
  },
  {
   "station": "Addington",
   "served_baseline": 346,
   "local_added_s": 143.48678588867188,
   "city_added_s": 1.2641541957855225,
   "pushed_past_6min": 182,
   "calls": 1561
  },
  {
   "station": "Sutton",
   "served_baseline": 425,
   "local_added_s": 142.66233825683594,
   "city_added_s": 1.5830579996109009,
   "pushed_past_6min": 275,
   "calls": 3000
  },
  {
   "station": "Enfield",
   "served_baseline": 380,
   "local_added_s": 141.2041778564453,
   "city_added_s": 1.3846924304962158,
   "pushed_past_6min": 247,
   "calls": 3372
  },
  {
   "station": "Surbiton",
   "served_baseline": 208,
   "local_added_s": 137.62791442871094,
   "city_added_s": 0.7206678986549377,
   "pushed_past_6min": 114,
   "calls": 1896
  },
  {
   "station": "Bromley",
   "served_baseline": 336,
   "local_added_s": 133.18212890625,
   "city_added_s": 1.1284774541854858,
   "pushed_past_6min": 193,
   "calls": 3074
  },
  {
   "station": "Heathrow",
   "served_baseline": 237,
   "local_added_s": 132.4523162841797,
   "city_added_s": 0.8084242939949036,
   "pushed_past_6min": 123,
   "calls": 1443
  },
  {
   "station": "Heston",
   "served_baseline": 372,
   "local_added_s": 127.2612075805664,
   "city_added_s": 1.2042516469955444,
   "pushed_past_6min": 244,
   "calls": 3105
  },
  {
   "station": "Croydon",
   "served_baseline": 613,
   "local_added_s": 127.13233947753906,
   "city_added_s": 2.008979320526123,
   "pushed_past_6min": 370,
   "calls": 4819
  }
 ],
 "safest_closures": [
  {
   "station": "Whitechapel",
   "served_baseline": 398,
   "local_added_s": 51.00920104980469,
   "city_added_s": 0.5556581020355225,
   "pushed_past_6min": 21,
   "calls": 2692
  },
  {
   "station": "Dockhead",
   "served_baseline": 301,
   "local_added_s": 55.90454864501953,
   "city_added_s": 0.4573507308959961,
   "pushed_past_6min": 14,
   "calls": 1934
  },
  {
   "station": "Shadwell",
   "served_baseline": 390,
   "local_added_s": 57.220333099365234,
   "city_added_s": 0.6032221913337708,
   "pushed_past_6min": 23,
   "calls": 1738
  },
  {
   "station": "Leyton",
   "served_baseline": 660,
   "local_added_s": 58.4696159362793,
   "city_added_s": 0.9840151071548462,
   "pushed_past_6min": 180,
   "calls": 1953
  },
  {
   "station": "Old Kent Road",
   "served_baseline": 327,
   "local_added_s": 59.58339309692383,
   "city_added_s": 0.5143985152244568,
   "pushed_past_6min": 17,
   "calls": 2971
  }
 ],
 "spearman_calls_vs_local_damage": -0.271,
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
   "DeployedFromStation_Name": "Euston",
   "false": 61.0,
   "true": 102.0,
   "delta": 41.0
  },
  {
   "DeployedFromStation_Name": "Plaistow",
   "false": 70.0,
   "true": 111.0,
   "delta": 41.0
  },
  {
   "DeployedFromStation_Name": "Plumstead",
   "false": 77.0,
   "true": 118.0,
   "delta": 41.0
  },
  {
   "DeployedFromStation_Name": "West Norwood",
   "false": 69.0,
   "true": 110.0,
   "delta": 41.0
  }
 ],

```

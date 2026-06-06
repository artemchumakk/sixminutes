import type { Workspace } from "./types";

export const WORKSPACES: Workspace[] = [
  {
    id: "ambulance",
    name: "London Ambulance Service",
    short: "Ambulance",
    icon: "✚",
    promiseMin: 7,
    accent: "#5eead4",
    available: true,
    blurb: "C1 7-min promise · learned response physics · live transfer model",
  },
  {
    id: "fire",
    name: "London Fire Brigade",
    short: "Fire",
    icon: "▲",
    promiseMin: 6,
    accent: "#fb923c",
    available: true,
    blurb: "6-min promise · validated twin · click stations, watch London re-simulate",
  },
  {
    id: "police",
    name: "Metropolitan Police",
    short: "Police",
    icon: "◆",
    promiseMin: 15,
    accent: "#60a5fa",
    available: false,
    blurb: "15-min promise · owned by the police tier team",
  },
];

export const getWorkspace = (id: string) =>
  WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0];

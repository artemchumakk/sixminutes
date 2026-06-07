// leaflet.heat attaches itself to a bare global `L` (no ESM export). Under Vite
// we must publish Leaflet onto window BEFORE the plugin module executes, so this
// side-effect module is imported ahead of `import "leaflet.heat"`.
import L from "leaflet";

(window as unknown as { L?: typeof L }).L = L;

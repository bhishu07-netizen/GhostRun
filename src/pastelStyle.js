// Ghostrun pastel map style on top of OpenFreeMap vector tiles (OpenMapTiles schema).
export const C = {
  bg: '#FBF3FC',
  campus: '#F3E8FC',
  farm: '#F8F1F4',
  grass: '#D7F0CC',
  wood: '#C6E6B8',
  pitch: '#C8EBBD',
  water: '#C9DDFB',
  building: '#E3D3F7',
  buildingLine: '#CDB6F0',
  road: '#FFFFFF',
  roadCase: '#E6DAF7',
  path: '#E9DDF7',
  ink: '#3B2A6B',
  muted: '#6E5F8F',
};

const roadWidth = (base) => [
  'interpolate', ['exponential', 1.6], ['zoom'],
  12, base * 0.5,
  15, base * 2.2,
  18, base * 9,
];

const CLS = ['get', 'class'];
const MAJOR = ['motorway', 'trunk', 'primary'];
const MID = ['secondary', 'tertiary'];
// one interpolate on the outside, a match per zoom stop inside (MapLibre allows only one zoom curve)
const widthBy = (major, mid, minor) => [
  'interpolate', ['exponential', 1.6], ['zoom'],
  ...[[12, 0.5], [15, 2.2], [18, 9]].flatMap(([z, k]) => [z, ['match', CLS, MAJOR, major * k, MID, mid * k, minor * k]]),
];

// Toy-town buildings: not the real heights or colours, a playful pastel mix picked per building.
const SEED = ['coalesce', ['id'], ['to-number', ['get', 'render_height'], 0], 0];
const PASTELS = ['#D9C6FA', '#F9C9E3', '#C7DAFE', '#C9F0D6', '#FDE2C4', '#FBF1B8'];
export const buildingColor = ['match', ['%', SEED, 6],
  0, PASTELS[0], 1, PASTELS[1], 2, PASTELS[2], 3, PASTELS[3], 4, PASTELS[4], PASTELS[5]];
// k goes 0 -> 1 when the map opens, so buildings grow out of the ground
export const buildingHeight = (k) => ['*', k, ['+', 7, ['*', 5, ['%', SEED, 5]]]];

export function pastelStyle() {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    light: { anchor: 'viewport', color: '#FFFFFF', intensity: 0.3, position: [1.2, 210, 40] },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
      {
        id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse',
        paint: {
          'fill-color': ['match', ['get', 'class'],
            ['university', 'college', 'school'], C.campus,
            ['farmland', 'farm'], C.farm,
            ['stadium', 'pitch', 'playground'], C.pitch,
            'rgba(0,0,0,0)'],
        },
      },
      {
        id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        paint: {
          'fill-color': ['match', ['get', 'class'],
            'wood', C.wood,
            ['grass', 'park'], C.grass,
            'farmland', C.farm,
            C.grass],
          'fill-opacity': 0.9,
        },
      },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': C.grass } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': C.water } },
      {
        id: 'paths', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.path, 'line-width': roadWidth(0.8), 'line-dasharray': [1, 1.5] },
      },
      {
        id: 'road-case', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['!', ['in', ['get', 'class'], ['literal', ['path', 'track', 'rail', 'transit']]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadCase,
          'line-width': widthBy(3.4, 2.6, 1.8),
        },
      },
      {
        id: 'road', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['!', ['in', ['get', 'class'], ['literal', ['path', 'track', 'rail', 'transit']]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.road,
          'line-width': widthBy(2.8, 2.1, 1.3),
        },
      },
      {
        id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': C.buildingLine, 'fill-opacity': 0.6 },
      },
      {
        id: 'building-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14.5,
        paint: {
          'fill-extrusion-color': buildingColor,
          'fill-extrusion-height': buildingHeight(0),
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.95,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 15,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': C.muted, 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.6 },
      },
      {
        id: 'poi', type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: 15,
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 13],
          'text-max-width': 8,
        },
        paint: { 'text-color': C.ink, 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.8 },
      },
      {
        id: 'places', type: 'symbol', source: 'omt', 'source-layer': 'place',
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': 13,
        },
        paint: { 'text-color': C.muted, 'text-halo-color': '#FFFFFF', 'text-halo-width': 2 },
      },
    ],
  };
}

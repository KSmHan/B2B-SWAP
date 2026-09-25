/* =====================================================================
   B2B SWAP — automatic material cataloguing for uploaded stock lists.

   Every row of an uploaded file is classified into one material type
   (aluminum, copper, steel, MDF, plywood, …) by keyword rules that
   understand both English and Russian stock lists, including common
   alloy / grade designations (6061, АМг3, AISI 304, 09Г2С, ФК, …).

   ORDER MATTERS: more specific types are checked before general ones,
   so "stainless steel" lands in Stainless (not Steel), "ЛДСП" in
   Chipboard, "copper cable" in Copper, and so on.
   ===================================================================== */
'use strict';

// Letter classes used instead of \b, which does not work for Cyrillic.
const L = 'a-zа-я';
const NB = `(?:^|[^${L}])`;       // not preceded by a letter
const NA = `(?=[^${L}\\d]|$)`;   // not followed by a letter/digit

function rx(src) { return new RegExp(src, 'i'); }

const MATERIALS = [
  { key: 'stainless', label: 'Stainless steel', group: 'metal',
    re: rx(`нерж|stainless|inox|aisi\\s*-?\\s*[34]\\d\\d|${NB}(12х18н10т|08х18н10т?|20х13|х18н9)${NA}`) },
  { key: 'galvanized', label: 'Galvanized steel', group: 'metal',
    re: rx(`оцинк|galvani[sz]|zinc[\\s-]?coated`) },
  { key: 'aluminum', label: 'Aluminum', group: 'metal',
    re: rx(`алюмин|дюрал|alumin|${NB}(ад0|ад1|ад31т?1?|ад33|амг\\d*|амц|д16т?|в95|1105)${NA}|(?:aa|en\\s?aw-?)\\s?\\d{4}|(?:^|[^\\d])(5052|5083|5754|6060|6061|6063|6082|7075|2024)[\\s-]?(t\\d{1,4}|h\\d{2,3})`) },
  { key: 'copper', label: 'Copper', group: 'metal',
    re: rx(`${NB}мед(ь|и|ью)${NA}|медн|copper|${NB}(м1|м1т|м2т|м1р|м2р|мнж\\S*)${NA}`) },
  { key: 'brass', label: 'Brass', group: 'metal',
    re: rx(`латун|brass|${NB}(л63|л68|лс59(-1)?|лс58)${NA}`) },
  { key: 'bronze', label: 'Bronze', group: 'metal',
    re: rx(`бронз|bronze|${NB}бр(аж|амц|б2|оф|оц|кмц|х)`) },
  { key: 'titanium', label: 'Titanium', group: 'metal',
    re: rx(`титан|titanium|${NB}(вт1-0|вт1-00|вт6|от4)${NA}`) },
  { key: 'cast_iron', label: 'Cast iron', group: 'metal',
    re: rx(`чугун|cast[\\s-]*iron|${NB}(сч|вч)\\s?\\d\\d`) },
  { key: 'steel', label: 'Steel', group: 'metal',
    re: rx(`стал[ьи]|стальн|steel|арматур|rebar|швеллер|двутавр|i-?beam|h-?beam|профнастил|катанк|wire\\s*rod|` +
      `${NB}(уголок|балка|рельс|шв\\.?\\s?\\d)|` +
      `${NB}(ст\\.?\\s?[0-6](пс|сп|кп)?|09г2с|10хснд|40х|65г|30хгса|12х1мф|с255|с345|а500с?|а240|a36|s235|s355)${NA}|` +
      `[гх]\\/к|профильн\\S*\\s+труб|труба\\s+профил|вгп|электросвар`) },

  { key: 'mdf', label: 'MDF', group: 'wood',
    re: rx(`${NB}л?мдф|(?:^|[^a-z])mdf`) },
  { key: 'hdf', label: 'HDF / hardboard', group: 'wood',
    re: rx(`хдф|(?:^|[^a-z])hdf|двп|оргалит|hardboard|fib(er|re)board`) },
  { key: 'plywood', label: 'Plywood', group: 'wood',
    re: rx(`фанер|plywood|${NB}(фк|фсф|фб|лфсф)${NA}`) },
  { key: 'chipboard', label: 'Chipboard / particleboard', group: 'wood',
    re: rx(`л?дсп|chipboard|particle\\s*board|melamine\\s*board|${NB}л?дстп${NA}`) },
  { key: 'osb', label: 'OSB', group: 'wood',
    re: rx(`(?:^|[^a-z])osb|${NB}(осб|осп)(-?\\d)?${NA}`) },
  { key: 'lumber', label: 'Lumber & timber', group: 'wood',
    re: rx(`пиломат|${NB}(брус|доск|вагонк|рейк|горбыл|шпон)|мебельн\\S*\\s+щит|клеен\\S*\\s+щит|lumber|timber|veneer|${NB}(plank|boards?\\s+(pine|oak|spruce|birch))`) },

  { key: 'plastic', label: 'Plastics & polymers', group: 'other',
    re: rx(`пластик|пвх|(?:^|[^a-z])pvc|полипропилен|полиэтилен|${NB}(пнд|пвд|пэт|абс|пп|пэ)${NA}|поликарбонат|оргстекл|акрил|капролон|фторопласт|` +
      `plastic|polycarbonate|acrylic|plexi|polypropylene|polyethylene|(?:^|[^a-z])(hdpe|ldpe|pet|abs|pp|nylon|resin)(?:[^a-z]|$)`) },
  { key: 'glass', label: 'Glass', group: 'other',
    re: rx(`стекл|зеркал|glass|mirror`) },
  { key: 'rubber', label: 'Rubber', group: 'other',
    re: rx(`резин|rubber|${NB}epdm`) },
  { key: 'packaging', label: 'Packaging', group: 'other',
    re: rx(`поддон|паллет|коробк|картон|гофро|стрейч|биг-?бэг|мешк|упаков|pallet|carton|cardboard|corrugated|crate|stretch\\s*film|packag|bulk\\s*bags?|${NB}(box|boxes)${NA}`) },
  { key: 'components', label: 'Components & parts', group: 'other',
    re: rx(`подшипник|двигател|электродвиг|редуктор|клапан|задвижк|насос|крепеж|болт|гайк|винт|саморез|bearing|motor|gearbox|reducer|valve|pump|fastener|bolt|${NB}(nuts?|screws?)${NA}`) },
  { key: 'cable', label: 'Cable & wire', group: 'other',
    re: rx(`кабел|провод|${NB}(ввг|ввгнг|пвс|шввп|кгтп)(нг)?${NA}|cable|${NB}wire${NA}`) },
  { key: 'metal_other', label: 'Other metals', group: 'metal',
    re: rx(`свин(ец|цов)|${NB}цинк|никел|олово|оловян|магни[йе]в?|вольфрам|молибден|${NB}(lead|nickel|zinc|tin|tungsten)${NA}|металл|metal`) },
];

const OTHER = { key: 'other', label: 'Other', group: 'other' };
const ALL = [...MATERIALS, OTHER];
const BY_KEY = new Map(ALL.map(m => [m.key, m]));

function normalize(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/** Returns a material key, or null when nothing recognisable is in `text`. */
function classify(text) {
  const s = normalize(text);
  if (!s.trim()) return null;
  for (const m of MATERIALS) if (m.re.test(s)) return m.key;
  return null;
}

function isMaterial(key) { return BY_KEY.has(key); }
function materialLabel(key) { return (BY_KEY.get(key) || OTHER).label; }
function listMaterials() { return ALL.map(({ key, label, group }) => ({ key, label, group })); }

module.exports = { classify, isMaterial, materialLabel, listMaterials, MATERIAL_KEYS: ALL.map(m => m.key) };

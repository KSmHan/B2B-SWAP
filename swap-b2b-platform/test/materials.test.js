'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, listMaterials, isMaterial } = require('../lib/materials');

const CASES = {
  aluminum: ['Лист алюминиевый АМг3 2мм', 'Профиль 6063-T5', 'Круг Д16Т ф60', 'Aluminum extrusion 6061-T6', 'aluminium coil', 'EN AW-5754 sheet'],
  copper: ['Труба медная 22х1', 'Шина М1Т 5х40', 'Copper wire rod', 'лом меди'],
  brass: ['Пруток латунный ЛС59-1', 'Brass rod 20mm'],
  bronze: ['Бронза БрАЖ9-4', 'Bronze round bar'],
  stainless: ['Лист нержавеющий AISI 304', 'Stainless Steel 304 Coil', 'Труба 12Х18Н10Т'],
  galvanized: ['Лист оцинкованный 0.5', 'Galvanized steel pipe DN50'],
  steel: ['Лист г/к Ст3сп 4мм', 'Арматура А500С 12', 'Швеллер 16П', 'Уголок 50х50х5', 'Hot-rolled steel sheet', 'Rebar 12mm', 'Лист 09Г2С 10мм'],
  cast_iron: ['Чугун СЧ20 чушка'],
  titanium: ['Титан ВТ1-0 лист', 'Titanium sheet grade 5'],
  mdf: ['МДФ 16мм', 'MDF board 18 mm', 'ЛМДФ белый'],
  hdf: ['ДВП 3мм', 'ХДФ 2.5', 'HDF panel'],
  plywood: ['Фанера ФК 10мм', 'Plywood birch 18mm', 'фанера березовая'],
  chipboard: ['ЛДСП Egger 16', 'ДСП 16мм', 'Chipboard 18mm'],
  osb: ['OSB-3 12мм', 'ОСП 9мм', 'OSB board'],
  lumber: ['Брус 100х100', 'Доска обрезная 50х150', 'Lumber 2x4 pine'],
  plastic: ['HDPE pellets', 'Лист ПВХ 3мм', 'Поликарбонат сотовый', 'ABS plastic'],
  packaging: ['EUR pallets', 'Поддон деревянный', 'Коробка картонная', 'Stretch film 20 micron'],
  components: ['Ball bearings 6205', 'Подшипник 6205', 'Motor 5.5kW'],
  cable: ['Кабель ВВГнг 3х2.5', 'Power cable 3x2.5'],
};

for (const [key, samples] of Object.entries(CASES)) {
  test(`classifies ${key}`, () => {
    for (const s of samples) assert.equal(classify(s), key, s);
  });
}

test('does not guess from units, years or thread sizes', () => {
  for (const s of ['150 кг', '100 м2', 'Отчет 2024', 'Шпилька М10', 'Итого', '']) assert.equal(classify(s), null, s);
});

test('material list is stable and includes "other"', () => {
  const keys = listMaterials().map(m => m.key);
  for (const k of ['aluminum', 'copper', 'steel', 'mdf', 'plywood', 'other']) assert.ok(keys.includes(k), k);
  assert.ok(isMaterial('mdf'));
  assert.ok(!isMaterial('nope'));
});

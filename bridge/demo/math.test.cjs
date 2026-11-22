const {test}=require('node:test');
const assert=require('node:assert/strict');
const {add}=require('./math.cjs');
test('adds positive numbers',()=>assert.equal(add(2,3),5));
test('adds negative numbers',()=>assert.equal(add(-2,-3),-5));

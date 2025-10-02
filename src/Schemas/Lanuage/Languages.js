// models/Languages.js
'use strict';

const mongoose = require('mongoose');
const LanguagesShape = require('./LanguagesSchema'); // your plain shape object

// === Config: how many items to keep ===
let MAX_ITEMS = Number(process.env.LANGUAGES_MAX_DAYS_ITEMS || 14); // default 14
function setMaxItems(x) {
  const n = Number(x);
  MAX_ITEMS = Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
  return MAX_ITEMS;
}
function clampMax(m) { return Math.max(1, Number(m) || 1); }
function trimToMax(arr, max = MAX_ITEMS) {
  if (!Array.isArray(arr)) return arr;
  const m = clampMax(max);
  return arr.length > m ? arr.slice(-m) : arr;
}

// === Schema (bind to your real collection) ===
const schema = new mongoose.Schema(
  LanguagesShape,
  { timestamps: true, collection: 'languagesschemas' } // <- matches your Compass collection
);

// === Document hook: whenever a doc is saved, trim to last X ===
schema.pre('save', function(next) {
  if (Array.isArray(this.days)) {
    this.days = trimToMax(this.days);
    this.markModified('days'); // ensure change is picked up
  }
  next();
});

// === Query middleware: if an update does $push on days, inject $slice:-X atomically ===
function injectSlice(ctx) {
  const u = ctx.getUpdate() || {};
  const pushContainer = u.$push;
  if (!pushContainer || !Object.prototype.hasOwnProperty.call(pushContainer, 'days')) return;

  const m = clampMax(ctx.options?.maxItems || MAX_ITEMS);
  const pushVal = pushContainer.days;

  if (pushVal && typeof pushVal === 'object' && ('$each' in pushVal || '$slice' in pushVal || '$position' in pushVal)) {
    const { $each = [], $position, ...rest } = pushVal;
    u.$push.days = {
      $each: Array.isArray($each) ? $each : [$each],
      ...( $position !== undefined ? { $position } : {} ),
      $slice: -m,                    // <-- keep only last m items
      ...rest
    };
  } else {
    // $push: { days: <oneItem> } -> convert to $each + $slice
    u.$push.days = { $each: [pushVal], $slice: -m };
  }

  ctx.setUpdate(u);
}
['findOneAndUpdate', 'updateOne', 'updateMany'].forEach(op =>
  schema.pre(op, function(next) { injectSlice(this); next(); })
);

// === Statics for convenient usage ===
schema.statics.setMaxItems = setMaxItems;

/**
 * Push a new day and keep only last X items, atomically.
 * @param {Object} filter  e.g. { value: 'en' }
 * @param {Object} dayDoc  e.g. { value: '2025-10-02', difficulties: [...] }
 * @param {number} [maxItems] override global X for this call
 */
schema.statics.pushDayLimited = function(filter, dayDoc, maxItems) {
  const m = clampMax(maxItems || MAX_ITEMS);
  return this.updateOne(
    filter,
    { $push: { days: { $each: [dayDoc], $slice: -m } } },
    { upsert: true }
  );
};

/**
 * Trim all docs to last X items using pipeline update (MongoDB 4.2+).
 * Handy if you changed X and want to enforce it once.
 */
schema.statics.trimAll = function(maxItems) {
  const m = clampMax(maxItems || MAX_ITEMS);
  return this.updateMany({}, [
    { $set: {
        days: {
          $cond: [
            { $gt: [ { $size: '$days' }, m ] },
            { $slice: ['$days', -m] },
            '$days'
          ]
        }
      }
    }
  ]);
};

const Languages = mongoose.model('Languages', schema);
module.exports = Languages;

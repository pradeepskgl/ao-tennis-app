const mongoose = require('mongoose');
const { Schema } = mongoose;

const formatSchema = new Schema(
  {
    games: { type: Number, enum: [4, 6], default: 6 },
    scoring: { type: String, enum: ['ad', 'noad'], default: 'ad' },
    setsMode: { type: String, enum: ['best3', 'best2_mtb10'], default: 'best3' },
  },
  { _id: false }
);

// A singles player, or a doubles team (player1 / player2).
const entrySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  player1: { type: String, trim: true, maxlength: 60 },
  player2: { type: String, trim: true, maxlength: 60 },
});

const stageSchema = new Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true, maxlength: 60 },
    kind: { type: String, enum: ['group', 'knockout'], required: true },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const groupSchema = new Schema(
  { stageKey: String, name: String, entryIds: [Schema.Types.ObjectId] },
  { _id: false }
);

// Admin's pick for a group finishing position that feeds the next stage (overrides the standings).
const promotionSchema = new Schema(
  { stageKey: String, group: String, rank: Number, entry: Schema.Types.ObjectId },
  { _id: false }
);

const tournamentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, enum: ['singles', 'doubles'], required: true },
    status: { type: String, enum: ['setup', 'live', 'completed'], default: 'setup' },
    entries: [entrySchema],
    stages: [stageSchema],
    groups: [groupSchema],
    promotions: { type: [promotionSchema], default: [] },
    defaultFormat: { type: formatSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// Where a knockout slot gets its player from, when not set directly:
//   { kind: 'winner', match }              - winner of an earlier match
//   { kind: 'group', stageKey, group, rank } - a finishing position in a group
const sourceSchema = new Schema(
  {
    kind: { type: String, enum: ['winner', 'group'], required: true },
    match: { type: Schema.Types.ObjectId },
    stageKey: String,
    group: String,
    rank: Number,
  },
  { _id: false }
);

// Doubles: a team may change its serving order at the start of each set (set is 1-based, 2 or later).
const serveOrderSchema = new Schema(
  {
    set: { type: Number, required: true, min: 2, max: 5 },
    aFirst: { type: Number, enum: [1, 2], default: 1 },
    bFirst: { type: Number, enum: [1, 2], default: 1 },
    aDeuce: { type: Number, enum: [1, 2, null], default: null }, // player receiving in the deuce court
    bDeuce: { type: Number, enum: [1, 2, null], default: null },
  },
  { _id: false }
);

// Coin toss. The winner picks serve/receive or the end, or defers the first pick to the opponent;
// the other side gets the remaining choice. See Scoring.tossOutcome.
const tossSchema = new Schema(
  {
    winner: { type: String, enum: ['a', 'b'], required: true },
    choice: { type: String, enum: ['serve', 'end', 'defer'], required: true },
    deferredChoice: { type: String, enum: ['serve', 'end', null], default: null }, // opponent's pick after a defer
    decision: { type: String, enum: ['serve', 'receive'], required: true }, // made by whoever picked serve/receive
    end: { type: String, default: '', maxlength: 40 }, // starting end, as named at the venue (optional)
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const matchSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
    stageKey: { type: String, required: true },
    group: { type: String, default: '' },
    round: { type: Number, default: 1 },
    order: { type: Number, default: 0 },
    sideA: { type: Schema.Types.ObjectId, default: null },
    sideB: { type: Schema.Types.ObjectId, default: null },
    sourceA: { type: sourceSchema, default: null },
    sourceB: { type: sourceSchema, default: null },
    format: { type: formatSchema, default: () => ({}) },
    log: { type: [String], default: [] }, // 'a' | 'b' per point; state is derived from this
    state: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['scheduled', 'live', 'completed'], default: 'scheduled' },
    winnerSide: { type: String, enum: ['a', 'b', null], default: null },
    walkover: { type: Boolean, default: false },
    manual: { type: Boolean, default: false }, // final score typed in rather than scored point by point
    serve: {
      first: { type: String, enum: ['a', 'b', null], default: null }, // side serving the first game
      aFirst: { type: Number, enum: [1, 2], default: 1 }, // doubles: which player of side A serves first
      bFirst: { type: Number, enum: [1, 2], default: 1 },
      aDeuce: { type: Number, enum: [1, 2, null], default: null }, // doubles: player of side A receiving in the deuce court
      bDeuce: { type: Number, enum: [1, 2, null], default: null },
      sets: { type: [serveOrderSchema], default: [] }, // doubles: serving order chosen again for a later set
    },
    toss: { type: tossSchema, default: null },
    isBye: { type: Boolean, default: false },
    startedAt: { type: Date, default: null }, // "Start match" pressed; points can be scored from then on
    endedAt: { type: Date, default: null }, // set when the match finishes, for the match time
    scheduledAt: { type: String, default: '', maxlength: 60 },
    court: { type: String, default: '', maxlength: 40 },
    notes: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

// Scorer accounts: can score matches but not change tournaments, players or fixtures.
const scorerSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 30 },
    salt: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = {
  Tournament: mongoose.model('Tournament', tournamentSchema),
  Match: mongoose.model('Match', matchSchema),
  Scorer: mongoose.model('Scorer', scorerSchema),
};

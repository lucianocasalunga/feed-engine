import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8890'),
  strfryUrl: process.env.STRFRY_URL || 'ws://127.0.0.1:7777',
  redisUrl: process.env.REDIS_URL || 'redis://172.29.0.2:6379',
  ramdiskPath: process.env.RAMDISK_PATH || '/mnt/projetos/feed-engine/ramdisk',
  logLevel: process.env.LOG_LEVEL || 'info',

  scoring: {
    halfLifeHours: parseFloat(process.env.HALF_LIFE_HOURS || '12'),
    gravity: parseFloat(process.env.GRAVITY || '1.5'),
    recalcIntervalMs: parseInt(process.env.RECALC_INTERVAL_MS || '120000'),
  },

  weights: {
    reaction: parseInt(process.env.WEIGHT_REACTION || '1'),
    repost: parseInt(process.env.WEIGHT_REPOST || '2'),
    reply: parseInt(process.env.WEIGHT_REPLY || '8'),
    mutualReply: parseInt(process.env.WEIGHT_MUTUAL_REPLY || '25'),
    zapMultiplier: parseInt(process.env.WEIGHT_ZAP_MULTIPLIER || '10'),
  },

  wot: {
    recalcIntervalMs: parseInt(process.env.WOT_RECALC_INTERVAL_MS || '600000'),
  },
};

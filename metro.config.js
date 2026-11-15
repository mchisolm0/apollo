// https://docs.expo.dev/versions/v58.0.0/config/metro/
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// This repo's prototypes/ are separate apps with their own native build output (gigabytes under target/).
const prototypes = path.join(__dirname, 'prototypes', path.sep).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [...[].concat(config.resolver.blockList ?? []), new RegExp(`^${prototypes}`)];

module.exports = config;

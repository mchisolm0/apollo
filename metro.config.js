// https://docs.expo.dev/versions/v58.0.0/config/metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// prototypes/ are separate apps with their own native build output (gigabytes under target/).
config.resolver.blockList = [...[].concat(config.resolver.blockList ?? []), /[/\\]prototypes[/\\].*/];

module.exports = config;

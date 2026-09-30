module.exports = {
  dependencies: {
    // iOS uses Ekho's selectable renderer. The parsers export colliding C++ headers.
    'react-native-enriched-markdown': { platforms: { ios: null } },
  },
};

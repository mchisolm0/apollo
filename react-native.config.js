module.exports = {
  dependencies: {
    // iOS uses Apollo's selectable renderer. The parsers export colliding C++ headers.
    'react-native-enriched-markdown': { platforms: { ios: null } },
  },
};

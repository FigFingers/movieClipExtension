const path = require("node:path");

module.exports = {
  mode: "production",
  entry: {
    content: "./src/content/content_netflix.js",
    content_disney: "./src/content/content_disney.js",
    extension_link: "./src/content/extension_link.js",
    getClipData: "./src/content/getClipData.js",
    background: "./src/background/background.js",
  },
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
};

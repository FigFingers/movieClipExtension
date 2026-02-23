const path = require("path");

module.exports = {
  mode: "production",
  entry: {
    content: "./src/content/content_netflix.js",
    content_disney: "./src/content/content_disney.js",
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

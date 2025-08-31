const path = require("path");

module.exports = {
  mode: "development",
  devtool: "source-map",
  entry: {
    content: "./src/content/content.js",
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

const path = require("path");

module.exports = {
  mode: "production",
  entry: {
    netflix: "./src/content/netflix_content.js",
    disney: "./src/content/disney_content.js"
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

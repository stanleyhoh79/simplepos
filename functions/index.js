const { setGlobalOptions } = require("firebase-functions/v2");

setGlobalOptions({
  region: "asia-southeast1",
  maxInstances: 3
});

module.exports = {
  ...require("./pos"),
  ...require("./simplepay"),
  ...require("./affiliate"),
  ...require("./checkin"),
  ...require("./member"),
  ...require("./member-read"),
  ...require("./homepage")
};

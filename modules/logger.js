const clr = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

const logPre = () =>
  `${clr.red}[${new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}] ${clr.reset}`;

module.exports = { clr, logPre };

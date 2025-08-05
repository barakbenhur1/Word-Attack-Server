function wrap(body) {
   return {
        value: body,
      };
}

function exsit(prameter) {
  return prameter !== null && prameter !== undefined;
}

module.exports = { wrap, exsit }
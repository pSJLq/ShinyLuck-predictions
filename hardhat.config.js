require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
// Canonical Somnia infra RPC (same as ShinyLuck main repo).
const RPC_TESTNET = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";

const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    somniaTestnet: {
      url: RPC_TESTNET,
      chainId: 50312,
      accounts,
    },
  },
};

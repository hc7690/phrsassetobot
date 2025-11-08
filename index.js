// index.js — fixed: limit random decimals to token decimals (compatible ethers v5 & v6)
require('dotenv').config();
const readline = require('readline');

const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  USDT_ADDRESS,
  SUBSCRIBE_VALUE = '0',
  GAS_LIMIT = '400000',
} = process.env;

if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !USDT_ADDRESS) {
  console.error('Missing required env vars. Check .env file.');
  process.exit(1);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans); }));
}
const randomFloat = (min, max) => Math.random() * (max - min) + min;
const sleep = ms => new Promise(res => setTimeout(res, ms));

(async () => {
  // --- load ethers & detect shape ---
  let mod;
  try { mod = require('ethers'); } catch (e) {
    console.error('Please install ethers: npm i ethers');
    process.exit(1);
  }
  const isV6 = !!mod.JsonRpcProvider;
  const isV5 = !!(mod.ethers && mod.ethers.providers);

  if (!isV6 && !isV5) {
    console.error('Unsupported ethers package shape. Install ethers@6 or ethers@5.');
    process.exit(1);
  }

  // normalized bindings
  let Provider, Wallet, Contract, parseUnits, parseEther, MaxUint256, utils;
  if (isV6) {
    Provider = mod.JsonRpcProvider;
    Wallet = mod.Wallet;
    Contract = mod.Contract;
    parseUnits = mod.parseUnits;
    parseEther = mod.parseEther;
    MaxUint256 = mod.MaxUint256;
    utils = mod;
  } else {
    const { ethers } = mod;
    Provider = ethers.providers.JsonRpcProvider;
    Wallet = ethers.Wallet;
    Contract = ethers.Contract;
    parseUnits = ethers.utils.parseUnits;
    parseEther = ethers.utils.parseEther;
    MaxUint256 = ethers.constants.MaxUint256;
    utils = ethers.utils;
  }

  // --- connect to RPC with retry (exponential backoff) ---
  const MAX_ATTEMPTS = 8;
  const BASE_DELAY_MS = 2000;
  let provider, wallet;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      provider = new Provider(RPC_URL);
      wallet = new Wallet(PRIVATE_KEY, provider);
      const net = await provider.getNetwork();
      console.log(`Connected to RPC. chainId: ${net.chainId} (attempt ${attempt})`);
      break;
    } catch (e) {
      console.warn(`RPC attempt ${attempt} failed: ${e && e.message ? e.message : e}`);
      if (attempt === MAX_ATTEMPTS) {
        console.error('Exceeded max RPC connect attempts. Check RPC_URL / network.');
        process.exit(1);
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`Retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }

  // load ABIs & contracts
  const cashplusAbi = require('./cashplusABI.json');
  const contract = new Contract(CONTRACT_ADDRESS, cashplusAbi, wallet);

  const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address owner) external view returns (uint256)",
    "function decimals() view returns (uint8)"
  ];
  const usdt = new Contract(USDT_ADDRESS, ERC20_ABI, wallet);

  try {
    const myAddr = await wallet.getAddress();
    console.log('Wallet:', myAddr);
    console.log('CashPlus:', CONTRACT_ADDRESS);
    console.log('USDT:', USDT_ADDRESS);

    // prompts
    const minStr = await ask('Minimal nominal USDT per subscribe (mis. 0.1): ');
    const maxStr = await ask('Maksimal nominal USDT per subscribe (mis. 0.5): ');
    const loopsStr = await ask('Berapa kali loop (jumlah subscribe)? (mis. 5): ');
    const delayMinStr = await ask('Delay minimal antar loop (detik): ');
    const delayMaxStr = await ask('Delay maksimal antar loop (detik): ');

    const minVal = parseFloat(minStr);
    const maxVal = parseFloat(maxStr);
    const loops = parseInt(loopsStr);
    const delayMin = parseFloat(delayMinStr);
    const delayMax = parseFloat(delayMaxStr);

    if ([minVal, maxVal, loops, delayMin, delayMax].some(v => Number.isNaN(v))) {
      console.error('Input tidak valid (harus numerik).');
      process.exit(1);
    }
    if (minVal <= 0 || maxVal <= 0 || loops <= 0 || delayMin < 0 || delayMax < 0 || maxVal < minVal || delayMax < delayMin) {
      console.error('Range/values tidak valid. Pastikan min<=max, loops>0, delay>=0.');
      process.exit(1);
    }

    // get decimals and convert to Number
    const decimalsRaw = await usdt.decimals();
    // decimalsRaw might be BigInt (v6) or number (v5)
    const decimalsNum = Number(decimalsRaw.toString ? decimalsRaw.toString() : decimalsRaw);
    console.log('USDT decimals:', decimalsRaw.toString ? decimalsRaw.toString() : decimalsRaw);

    // check allowance once
    const approxMaxNeeded = parseUnits(maxVal.toString(), decimalsNum);
    const allowance = await usdt.allowance(myAddr, CONTRACT_ADDRESS);
    console.log('Allowance to CashPlus:', allowance.toString ? allowance.toString() : String(allowance));

    const allowTooSmall = (allowance.lt && allowance.lt(approxMaxNeeded)) || (allowance < approxMaxNeeded);
    if (allowTooSmall) {
      console.log('Approving MaxUint256 to CashPlus (this may take a moment)...');
      const approveTx = await usdt.approve(CONTRACT_ADDRESS, MaxUint256);
      console.log('Approve tx:', approveTx.hash ?? approveTx);
      const aprRcpt = await approveTx.wait();
      console.log('Approve confirmed. block:', aprRcpt.blockNumber ?? aprRcpt.blockHash);
    } else {
      console.log('Allowance sudah mencukupi.');
    }

    const valueWei = parseEther(SUBSCRIBE_VALUE.toString());
    console.log('SUBSCRIBE_VALUE (wei):', valueWei.toString ? valueWei.toString() : String(valueWei));

    for (let i = 1; i <= loops; i++) {
      // choose random nominal between minVal..maxVal
      const nominal = randomFloat(minVal, maxVal);

      // limit decimal places to token decimals to avoid parseUnits "too many decimals"
      const nominalStr = nominal.toFixed(decimalsNum);

      // parse using limited decimals
      const amountParsed = parseUnits(nominalStr, decimalsNum);

      console.log(`\n[${i}/${loops}] nominal: ${nominalStr} USDT | parsed: ${amountParsed.toString ? amountParsed.toString() : String(amountParsed)}`);

      try {
        const tx = await contract.subscribe(USDT_ADDRESS, amountParsed, {
          value: valueWei,
          gasLimit: Number(GAS_LIMIT)
        });
        console.log(`-> tx sent: ${tx.hash ?? tx}`);
        const rc = await tx.wait();
        const gasUsed = rc.gasUsed?.toString?.() ?? rc.gasUsed ?? '';
        console.log(`-> confirmed | block: ${rc.blockNumber ?? rc.blockHash} | gasUsed: ${gasUsed} | status: ${rc.status}`);
      } catch (e) {
        console.error('-> subscribe error:', e?.message ?? e);
      }

      if (i < loops) {
        const delaySec = randomFloat(delayMin, delayMax);
        console.log(`Waiting ${delaySec.toFixed(2)}s before next loop...`);
        await sleep(Math.floor(delaySec * 1000));
      }
    }

    console.log('\nSelesai semua loop.');
  } catch (err) {
    console.error('Fatal:', err);
    process.exit(1);
  }
})();

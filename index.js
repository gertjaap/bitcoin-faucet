#!/usr/bin/env node

var http = require('http')
var path = require('path')
var express = require('express')
var fs = require('fs')
var bitcoin = require('bitcoinjs-lib')
let coinSelect = require('coinselect');
let { Blockbook } = require('blockbook-client');
var QRCode = require('qrcode');
var TVTCNetwork = {
  messagePrefix: 'Vertcoin Signed Message:\n',
  bech32: 'tvtc',
  bip32: {
    public: 0x043587cf,
    private: 0x04358394
  },
  pubKeyHash: 0x4A,
  scriptHash: 0xC4,
  wif: 0xEF,
  feeRate: 100
};

const blockbook = new Blockbook({
  nodes: ['tvtc.blockbook.nxswap.com']
});

var usedAddresses = {};
var everyXHours = 1;
var PORT = process.env.FAUCET_PORT || process.env.PORT || 3000

var privkey = process.env.PRIVKEY

if (privkey == undefined) {
  var WALLET_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.tvtc-faucet')
  var WALLET_FILE = process.env.FAUCET_WALLET || path.join(process.env.HOME || process.env.USERPROFILE, '.tvtc-faucet', 'wallet')

  // check wallet dir exists
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdir(WALLET_DIR, { recursive: true }, (err) => {
      if (err) throw err;
    });
  }
  // initialize wallet
  if (!fs.existsSync(WALLET_FILE)) {
    privkey = bitcoin.ECPair.makeRandom({ network: TVTCNetwork }).toWIF()
    fs.writeFileSync(WALLET_FILE, privkey, {
      encoding: 'utf-8',
      flag: 'wx+'
    });
  } else {
    privkey = fs.readFileSync(WALLET_FILE, 'utf-8')
  }
}

var keypair = bitcoin.ECPair.fromWIF(privkey, TVTCNetwork);
var address = bitcoin.payments.p2wpkh({ pubkey: keypair.publicKey, network: TVTCNetwork }).address;

QRCode.toFile(path.join(__dirname, "address-qr.png"), "vertcoin:" + address, {}, function (err) {
  if (err) throw err
});

var template = "<h1>Starting up please retry later</h1>";
fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
  template = data.toString('ascii');
  template = template.replace("%address%", address);
});

var sentTemplate = "<h1>Starting up please retry later</h1>";
fs.readFile(path.join(__dirname, "sent.html"), (err, data) => {
  sentTemplate = data.toString('ascii');
});

var app = express()
app.get('/', (req, res) => {
  blockbook.getAddressDetails(address, { details: 'basic' }).then((result) => {
    let balance = result.balance;
    if (!result || !balance) {
      return res.sendStatus(500);
    }
    res.header("Content-Type", "text/html");
    res.status(200).send(template.replace("%balance%", parseInt(balance) / 100000000));
  });
});

app.get('/qr.png', function (req, res) {
  res.header("Content-Type", "image/png");
  res.sendFile(path.join(__dirname, "address-qr.png"));
});

// only vertcoin testnet supported for now
app.get('/withdrawal', function (req, res) {
  if (!req.query.address) {
    return res.status(422).send({ status: 'error', data: { message: 'You forgot to set the "address" parameter.' } });
  }
  try {
    bitcoin.address.toOutputScript(req.query.address, TVTCNetwork);
  } catch (e) {
    return res.status(422).send({ status: 'error', data: { message: 'Invalid address' } });
  }

  if (usedAddresses.hasOwnProperty(req.query.address)) {
    let last = usedAddresses[req.query.address];
    let hoursSince = ((Date.now() / 1000) - last) / 3600;
    if (hoursSince < everyXHours) {
      return res.status(422).send({ status: 'error', data: { message: `You already received some testnet coins on this address in the last ${everyXHours} hour(s).` } });
    }
  }

  // satoshis
  var amount = parseInt(req.query.amount, 10) || 500000000
  if (amount > 500000000 || amount == 0) amount = 500000000

  spend(keypair, req.query.address, amount, (result, err) => {
    if (err) return res.status(500).send({ status: 'error', data: { message: err.message } });
    usedAddresses[req.query.address] = Date.now() / 1000;
    res.header("Content-Type", "text/html");
    res.send(sentTemplate.replace("%txid%", txId));
  })
});

async function spend(keypair, toAddress, amount, callback) {
  let utxos = await buildUTXOs(address);

  if (utxos.length == 0) {
    return callback(false, new Error(`Address doesn't contain enough money to send.`));
  }

  var targets = [{ address: toAddress, value: amount }];
  let { inputs, outputs, fee } = coinSelect(utxos, targets, TVTCNetwork.feeRate)

  if (!inputs || !outputs || !fee) {
    return callback(false, new Error(`Failed to select inputs.`));
  }

  var tx = new bitcoin.Psbt({ network: TVTCNetwork });
  for (let input of inputs) {
    if (input.hasOwnProperty('nonWitnessUtxo')) {
      tx.addInput({
        hash: input.txId,
        index: input.vout,
        nonWitnessUtxo: input.nonWitnessUtxo
      })
    }
    else if (input.hasOwnProperty('witnessUtxo')) {
      tx.addInput({
        hash: input.txId,
        index: input.vout,
        witnessUtxo: input.witnessUtxo
      })
    }
  }

  outputs.forEach(output => {
    // Any unassigned change will be sent back to the address we are sending from..
    if (!output.address) {
      output.address = address;
    }
    tx.addOutput({
      address: output.address,
      value: output.value,
    })
  })

  tx.signAllInputs(keypair);
  tx.validateSignaturesOfAllInputs();
  tx.finalizeAllInputs();

  let txRawHex = tx.extractTransaction().toHex();
  txId = await blockbook.sendTx(txRawHex);
  return callback(txId, false);
}

async function buildUTXOs(address) {
  let getUtxos = await blockbook.getUtxosForAddress(address);
  if (getUtxos.length == 0) return [];

  var utxos = [];

  for (let utxo of getUtxos) {
    let getTx = await blockbook.getTxSpecific(utxo.txid);
    let txHex = getTx.hex;

    // get full vout index..
    let txVouts = getTx.vout;
    let vout;
    for (let txVout of txVouts) {
      if (txVout.n == utxo.vout) {
        vout = txVout;
        break;
      }
    }

    // Base object.. across all types
    let utxoObject = {
      txId: utxo.txid,
      vout: parseInt(utxo.vout),
      value: parseInt(utxo.value),
    }

    // Switch type..
    switch (vout.scriptPubKey.type) {
      case 'witness_v0_keyhash':
        utxoObject.witnessUtxo = {
          script: Buffer.from(vout.scriptPubKey.hex, 'hex'),
          value: parseInt(utxo.value)
        }
        break;

      default:
        //nonWitnessUtxo: Buffer.from(txHex, 'hex')
        console.log('unsupported input.. type:' + vout.scriptPubKey.type);
        break;
    }

    utxoObject.type = vout.scriptPubKey.type;
    utxos.push(utxoObject);
  }

  return utxos
}

var server = http.createServer(app)

server.listen(PORT, function (err) {
  if (err) console.error(err)
  console.log("Listening");
})
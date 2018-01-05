#!/usr/bin/env node

var http = require('http')
var path = require('path')
var express = require('express')
var fs = require('fs')
var request = require('request')
var bitcoin = require('bitcoinjs-lib')
var QRCode = require('qrcode');
var vertcoinNetwork = {
  messagePrefix: 'Vertcoin Signed Message:\n',
  bip32: {
    public: 0x043587cf,
    private: 0x04358394
  },
  pubKeyHash: 0x4A,
  scriptHash: 0xC4,
  wif: 0xEF
};

var usedAddresses = [];
var PORT = process.env.FAUCET_PORT || process.env.PORT || 14004

var privkey = process.env.PRIVKEY

if (privkey == undefined) {
  var WALLET_FILE = process.env.FAUCET_WALLET || path.join(process.env.HOME || process.env.USERPROFILE, '.bitcoin-faucet', 'wallet')

  // initialize wallet
  if (!fs.existsSync(WALLET_FILE)) {
    privkey = bitcoin.ECPair.makeRandom({network: vertcoinNetwork, compressed: false}).toWIF()
    fs.writeFileSync(WALLET_FILE, privkey, 'utf-8')
  } else {
    privkey = fs.readFileSync(WALLET_FILE, 'utf-8')
  }
}



var keypair = bitcoin.ECPair.fromWIF(privkey, vertcoinNetwork)
var address = keypair.getAddress().toString()

QRCode.toFile(path.join(__dirname,"address-qr.png"), "vertcoin:" + address, {}, function (err) {
  if (err) throw err
  console.log('done')
});

var template = "<h1>Starting up please retry later</h1>";
fs.readFile(path.join(__dirname,"index.html"), (err, data) => {
  template = data.toString('ascii');
  template = template.replace("%address%", address);
});

var sentTemplate = "<h1>Starting up please retry later</h1>";
fs.readFile(path.join(__dirname,"sent.html"), (err, data) => {
  sentTemplate = data.toString('ascii');
});

var app = express()
app.get('/', function (req, res) {
  request.get('https://tvtc.blkidx.org/addressBalance/' + address + '?unconfirmed=1', {json:false}, (err, result, body) => {
    if(err) return res.sendStatus(500);
    res.header("Content-Type","text/html");
    res.send(template.replace("%balance%", parseInt(body)/100000000));
  });
});

app.get('/qr.png', function(req,res) {
  res.header("Content-Type", "image/png");
  res.sendFile(path.join(__dirname,"address-qr.png"));
});

// only bitcoin testnet supported for now
app.get('/withdrawal', function (req, res) {
  if (!req.query.address) {
    return res.status(422).send({ status: 'error', data: { message: 'You forgot to set the "address" parameter.' } });
  }
  try {
    var addy = bitcoin.address.fromBase58Check(req.query.address);
    if(addy.version != vertcoinNetwork.pubKeyHash) {
      return res.status(422).send({ status: 'error', data: { message: 'Invalid address version byte' } });
    }
  } catch(e) {
    console.log(e);
    return res.status(422).send({ status: 'error', data: { message: 'Invalid address' } });
  }
  
  if (usedAddresses.find((s) => { return (s == req.query.address); }) != null) {
    return res.status(422).send({ status: 'error', data: { message: 'You already received some testnet coins on this address.' } });
  }

  usedAddresses.push(req.query.address);

  // satoshis
  var amount = parseInt(req.query.amount, 10) || 500000000
  if(amount > 500000000) amount = 500000000

  spend(keypair, req.query.address, amount, function (err, txId) {
    if (err) return res.status(500).send({status: 'error', data: {message: err.message}})
    res.header("Content-Type","text/html");
    res.send(sentTemplate.replace("%txid%", txId));
  })
});

function spend(keypair, toAddress, amount, callback) {
  request.get('https://tvtc.blkidx.org/addressTxos/' + address + '?unconfirmed=1', {json:true}, (err, result, body) => {
    if (err) return callback(err)
    
    var tx = new bitcoin.TransactionBuilder(vertcoinNetwork);
    var total = 0;
    body.forEach((txo) => {
        if(txo.spender == null) {
            if(total <= (amount + 100000)) {
                total += txo.value;
                tx.addInput(txo.txhash,txo.vout);
            }
        }
    });
    if (amount + 100000 > total) {
      return callback(new Error('Address doesn\'t contain enough money to send.'))
    }
    tx.addOutput(address, total-amount-100000);
    tx.addOutput(toAddress, amount);
    tx.inputs.forEach((input, i) => {
      tx.sign(i, keypair);
    });
    var txHex = tx.build().toHex();
    request.post('https://tvtc.blkidx.org/sendRawTransaction', { body : txHex }, (err, result, body) => {
      if (err) return callback(err)
      callback(null, body);
    });
  });
}

var server = http.createServer(app)

server.listen(PORT, function (err) {
  if (err) console.error(err)
  console.log("Listening");
})

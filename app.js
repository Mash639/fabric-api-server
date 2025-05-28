/*
 * Copyright IBM Corp. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const bodyParser = require('body-parser');
const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json()); // To parse JSON request bodies

// --- Fabric Connection Configuration ---
const channelName = envOrDefault('CHANNEL_NAME', 'mychannel');
const chaincodeName = envOrDefault('CHAINCODE_NAME', 'basic');
const mspId = envOrDefault('MSP_ID', 'Org1MSP');

// Path to crypto materials.
const cryptoPath = envOrDefault(
    'CRYPTO_PATH',
    path.resolve(
        __dirname,
        '..',
        '..',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org1.example.com'
    )
);

// Path to user private key directory.
const keyDirectoryPath = envOrDefault(
    'KEY_DIRECTORY_PATH',
    path.resolve(
        cryptoPath,
        'users',
        'User1@org1.example.com',
        'msp',
        'keystore'
    )
);

// Path to user certificate directory.
const certDirectoryPath = envOrDefault(
    'CERT_DIRECTORY_PATH',
    path.resolve(
        cryptoPath,
        'users',
        'User1@org1.example.com',
        'msp',
        'signcerts'
    )
);

// Path to peer tls certificate.
const tlsCertPath = envOrDefault(
    'TLS_CERT_PATH',
    path.resolve(cryptoPath, 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt')
);

// Gateway peer endpoint.
const peerEndpoint = envOrDefault('PEER_ENDPOINT', 'localhost:7051');

// Gateway peer SSL host name override.
const peerHostAlias = envOrDefault('PEER_HOST_ALIAS', 'peer0.org1.example.com');

const utf8Decoder = new TextDecoder();

// --- Module-level variables for the shared Fabric Gateway connection ---
let sharedClient;
let sharedGateway;
let sharedNetwork;
let sharedContract;

// --- Fabric Connection and Utility Functions (Modified for single instance) ---

async function initializeFabricGateway() {
    if (sharedGateway && sharedClient && sharedNetwork && sharedContract) {
        console.log(
            'Fabric Gateway already initialized. Reusing existing connection.'
        );
        return; // Already initialized
    }

    console.log('Initializing Fabric Gateway connection...');
    sharedClient = await newGrpcConnection();
    const identity = await newIdentity();
    const signer = await newSigner();

    sharedGateway = connect({
        client: sharedClient,
        identity,
        signer,
        hash: hash.sha256,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 5000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    sharedNetwork = sharedGateway.getNetwork(channelName);
    sharedContract = sharedNetwork.getContract(chaincodeName);

    console.log('Fabric Gateway connection initialized successfully.');
}

// These functions remain the same as they create the individual components
async function newGrpcConnection() {
    const tlsRootCert = await fs.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': peerHostAlias,
    });
}

async function newIdentity() {
    const certPath = await getFirstDirFileName(certDirectoryPath);
    const credentials = await fs.readFile(certPath);
    return { mspId, credentials };
}

async function getFirstDirFileName(dirPath) {
    const files = await fs.readdir(dirPath);
    const file = files[0];
    if (!file) {
        throw new Error(`No files in directory: ${dirPath}`);
    }
    return path.join(dirPath, file);
}

async function newSigner() {
    const keyPath = await getFirstDirFileName(keyDirectoryPath);
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}

function envOrDefault(key, defaultValue) {
    return process.env[key] || defaultValue;
}

// Middleware to ensure gateway is initialized before handling requests
app.use(async (req, res, next) => {
    try {
        await initializeFabricGateway();
        next();
    } catch (error) {
        console.error('Failed to initialize Fabric Gateway:', error);
        res.status(500).json({
            error: 'Failed to connect to Fabric network. Server error.',
        });
    }
});

// --- API Endpoints ---

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Fabric API Server is running!');
});

// Initialize Ledger
app.post('/api/init-ledger', async (req, res) => {
    try {
        // Use the sharedContract directly
        console.log('\n--> API Call: InitLedger');
        await sharedContract.submitTransaction('InitLedger');
        res.status(200).json({ message: 'Ledger initialized successfully' });
    } catch (error) {
        console.error('Failed to initialize ledger:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all assets
app.get('/api/assets', async (req, res) => {
    try {
        // Use the sharedContract directly
        console.log('\n--> API Call: GetAllAssets');
        const resultBytes = await sharedContract.evaluateTransaction(
            'GetAllAssets'
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        const result = JSON.parse(resultJson);
        res.status(200).json(result);
    } catch (error) {
        console.error('Failed to get all assets:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create a new asset
app.post('/api/assets', async (req, res) => {
    const { assetId, color, size, owner, appraisedValue } = req.body;

    if (!assetId || !color || !size || !owner || !appraisedValue) {
        return res
            .status(400)
            .json({ error: 'Missing required fields for asset creation.' });
    }

    try {
        // Use the sharedContract directly
        console.log('\n--> API Call: CreateAsset', {
            assetId,
            color,
            size,
            owner,
            appraisedValue,
        });
        await sharedContract.submitTransaction(
            'CreateAsset',
            assetId,
            color,
            size,
            owner,
            appraisedValue
        );
        res.status(201).json({
            message: `Asset ${assetId} created successfully`,
        });
    } catch (error) {
        console.error('Failed to create asset:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get asset by ID
app.get('/api/assets/:assetId', async (req, res) => {
    const assetId = req.params.assetId;
    try {
        // Use the sharedContract directly
        console.log('\n--> API Call: ReadAsset by ID:', assetId);
        const resultBytes = await sharedContract.evaluateTransaction(
            'ReadAsset',
            assetId
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        const result = JSON.parse(resultJson);
        res.status(200).json(result);
    } catch (error) {
        if (error.message.includes('The asset with ID')) {
            res.status(404).json({
                error: `Asset with ID ${assetId} not found.`,
            });
        } else {
            console.error('Failed to read asset by ID:', error);
            res.status(500).json({ error: error.message });
        }
    }
});

// Transfer asset
app.put('/api/assets/:assetId/transfer', async (req, res) => {
    const assetId = req.params.assetId;
    const { newOwner } = req.body;

    if (!newOwner) {
        return res
            .status(400)
            .json({ error: 'Missing newOwner in request body.' });
    }

    try {
        // Use the sharedContract directly
        console.log('\n--> API Call: TransferAsset', { assetId, newOwner });

        const commit = await sharedContract.submitAsync('TransferAsset', {
            arguments: [assetId, newOwner],
        });
        const oldOwner = utf8Decoder.decode(commit.getResult());

        console.log(
            `Successfully submitted transaction to transfer ownership from ${oldOwner} to ${newOwner}`
        );
        console.log('Waiting for transaction commit...');

        const status = await commit.getStatus();
        if (!status.successful) {
            throw new Error(
                `Transaction ${
                    status.transactionId
                } failed to commit with status code ${String(status.code)}`
            );
        }

        res.status(200).json({
            message: `Asset ${assetId} ownership transferred from ${oldOwner} to ${newOwner}`,
        });
    } catch (error) {
        if (error.message.includes('The asset with ID')) {
            res.status(404).json({
                error: `Asset with ID ${assetId} not found for transfer.`,
            });
        } else {
            console.error('Failed to transfer asset:', error);
            res.status(500).json({ error: error.message });
        }
    }
});

// Update an asset
app.put('/api/assets/:assetId', async (req, res) => {
    const assetId = req.params.assetId;
    const { color, size, owner, appraisedValue } = req.body;

    if (!color || !size || !owner || !appraisedValue) {
        return res
            .status(400)
            .json({ error: 'Missing required fields for asset update.' });
    }

    try {
        // Use the sharedContract directly
        console.log('\n--> API Call: UpdateAsset', {
            assetId,
            color,
            size,
            owner,
            appraisedValue,
        });
        await sharedContract.submitTransaction(
            'UpdateAsset',
            assetId,
            color,
            size,
            owner,
            appraisedValue
        );
        res.status(200).json({
            message: `Asset ${assetId} updated successfully`,
        });
    } catch (error) {
        if (error.message.includes('The asset with ID')) {
            res.status(404).json({
                error: `Asset with ID ${assetId} not found for update.`,
            });
        } else {
            console.error('Failed to update asset:', error);
            res.status(500).json({ error: error.message });
        }
    }
});

// Start the server
app.listen(port, async () => {
    console.log(`Fabric API server listening at http://localhost:${port}`);
    console.log(`Channel Name: ${channelName}`);
    console.log(`Chaincode Name: ${chaincodeName}`);
    console.log(`MSP ID: ${mspId}`);
    console.log(`Crypto Path: ${cryptoPath}`);
    console.log(`Peer Endpoint: ${peerEndpoint}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    if (sharedGateway) {
        console.log('Closing Fabric Gateway...');
        sharedGateway.close();
    }
    if (sharedClient) {
        console.log('Closing gRPC client...');
        sharedClient.close();
    }
    process.exit(0);
});

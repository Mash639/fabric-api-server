/*
 * Copyright IBM Corp. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

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

// Middleware to parse JSON request bodies
app.use(bodyParser.json());

// --- Fabric Connection Configuration ---
const channelName = envOrDefault('CHANNEL_NAME', 'mychannel');
// Ensure this matches your deployed chaincode name.
const chaincodeName = envOrDefault('CHAINCODE_NAME', 'basic');

// Define paths for Org1, Org2, Org3 crypto materials
// IMPORTANT: These paths are relative to where your 'test-network' is located.
// Adjust '..' parts based on your exact directory structure.
const cryptoPathOrg1 = envOrDefault(
    'CRYPTO_PATH_ORG1',
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

const cryptoPathOrg2 = envOrDefault(
    'CRYPTO_PATH_ORG2',
    path.resolve(
        __dirname,
        '..',
        '..',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org2.example.com'
    )
);

const cryptoPathOrg3 = envOrDefault(
    'CRYPTO_PATH_ORG3',
    path.resolve(
        __dirname,
        '..',
        '..',
        'test-network',
        'organizations',
        'peerOrganizations',
        'org3.example.com'
    )
);

// Peer endpoints for each organization
const peerEndpointOrg1 = envOrDefault('PEER_ENDPOINT_ORG1', 'localhost:7051');
const peerEndpointOrg2 = envOrDefault('PEER_ENDPOINT_ORG2', 'localhost:9051');
const peerEndpointOrg3 = envOrDefault('PEER_ENDPOINT_ORG3', 'localhost:11051');

const utf8Decoder = new TextDecoder();

/**
 * Helper function to create a gRPC client connection for a specific organization's peer.
 * @param {string} orgCryptoPath Base crypto materials path for the organization.
 * @param {string} orgPeerEndpoint Peer endpoint for the organization.
 * @param {string} orgPeerHostAlias Peer host alias for the organization.
 * @returns {grpc.Client} The gRPC client instance.
 */
async function newGrpcConnection(
    orgCryptoPath,
    orgPeerEndpoint,
    orgPeerHostAlias
) {
    const tlsCertPath = path.resolve(
        orgCryptoPath,
        'peers',
        orgPeerHostAlias,
        'tls',
        'ca.crt'
    );
    const tlsRootCert = await fs.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(orgPeerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': orgPeerHostAlias,
    });
}

/**
 * Helper function to create an identity for a specific user and organization.
 * @param {string} userOrgMspId The MSP ID of the user's organization (e.g., 'Org1MSP').
 * @param {string} userCertDirectoryPath Path to the user's certificate directory.
 * @returns {Promise<object>} An object containing mspId and credentials.
 */
async function newIdentity(userOrgMspId, userCertDirectoryPath) {
    const certPath = await getFirstDirFileName(userCertDirectoryPath);
    const credentials = await fs.readFile(certPath);
    return { mspId: userOrgMspId, credentials };
}

/**
 * Helper function to create a signer for a specific user and organization.
 * @param {string} userKeyDirectoryPath Path to the user's private key directory.
 * @returns {Promise<signers.Signer>} The signer instance.
 */
async function newSigner(userKeyDirectoryPath) {
    const keyPath = await getFirstDirFileName(userKeyDirectoryPath);
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}

/**
 * Helper to get the first file name from a directory.
 * @param {string} dirPath The directory path.
 * @returns {Promise<string>} The full path to the first file.
 * @throws {Error} If no files are found.
 */
async function getFirstDirFileName(dirPath) {
    const files = await fs.readdir(dirPath);
    const file = files[0];
    if (!file) {
        throw new Error(`No files found in directory: ${dirPath}`);
    }
    return path.join(dirPath, file);
}

/**
 * Get environment variable or default value.
 * @param {string} key The environment variable name.
 * @param {string} defaultValue The default value if the environment variable is not set.
 * @returns {string} The environment variable value or default.
 */
function envOrDefault(key, defaultValue) {
    return process.env[key] || defaultValue;
}

// Define constants for your user types (these match what you use in `userType` in requests)
const USER_TYPE_SUPPLIER = 'supplier';
const USER_TYPE_TRANSPORTER = 'transporter';
const USER_TYPE_AGRODEALER = 'agrodealer';

// Define constants for the MSP IDs (these must match your Fabric network setup)
const ORG1_MSP_ID = 'Org1MSP';
const ORG2_MSP_ID = 'Org2MSP';
const ORG3_MSP_ID = 'Org3MSP';

// Define constants for the ADMIN user identities, which are automatically generated
// when you bring up the test-network
const ORG1_ADMIN_IDENTITY = 'Admin@org1.example.com';
const ORG2_ADMIN_IDENTITY = 'Admin@org2.example.com';
const ORG3_ADMIN_IDENTITY = 'Admin@org3.example.com';

/**
 * Main function to connect to Fabric Gateway and get a contract instance based on user's organization.
 * This function will establish a new connection for each request for simplicity,
 * but for production, you might want to manage a pool of connections or a single shared connection per organization.
 *
 * @param {string} userType Indicates which organization's admin user and crypto materials to use ('supplier', 'transporter', 'agrodealer').
 * @returns {Promise<{contract: import('@hyperledger/fabric-gateway').Contract, gateway: import('@hyperledger/fabric-gateway').Gateway}>} The Fabric contract and gateway instances.
 * @throws {Error} If connection fails or userType is invalid.
 */
async function getFabricContract(userType) {
    let cryptoPath,
        keyDirectoryPath,
        certDirectoryPath,
        peerEndpoint,
        peerHostAlias,
        userMspId,
        userIdentityName;

    switch (userType.toLowerCase()) {
        case USER_TYPE_SUPPLIER:
            userMspId = ORG1_MSP_ID;
            userIdentityName = ORG1_ADMIN_IDENTITY; // Using Org1 Admin
            cryptoPath = cryptoPathOrg1;
            keyDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                userIdentityName,
                'msp',
                'keystore'
            );
            certDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                userIdentityName,
                'msp',
                'signcerts'
            );
            peerEndpoint = peerEndpointOrg1;
            peerHostAlias = 'peer0.org1.example.com';
            break;
        case USER_TYPE_TRANSPORTER:
            userMspId = ORG2_MSP_ID;
            userIdentityName = ORG2_ADMIN_IDENTITY; // Using Org2 Admin
            cryptoPath = cryptoPathOrg2;
            keyDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                userIdentityName,
                'msp',
                'keystore'
            );
            certDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                userIdentityName,
                'msp',
                'signcerts'
            );
            peerEndpoint = peerEndpointOrg2;
            peerHostAlias = 'peer0.org2.example.com';
            break;
        case USER_TYPE_AGRODEALER:
            userMspId = ORG3_MSP_ID;
            userIdentityName = ORG3_ADMIN_IDENTITY; // Using Org3 Admin
            cryptoPath = cryptoPathOrg3;
            keyDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                userIdentityName,
                'msp',
                'keystore'
            );
            certDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                userIdentityName,
                'msp',
                'signcerts'
            );
            peerEndpoint = peerEndpointOrg3;
            peerHostAlias = 'peer0.org3.example.com';
            break;
        default:
            throw new Error(
                `Invalid user type: ${userType}. Must be '${USER_TYPE_SUPPLIER}', '${USER_TYPE_TRANSPORTER}', or '${USER_TYPE_AGRODEALER}'.`
            );
    }

    // CORRECTED LINE: Pass the necessary arguments to newGrpcConnection
    const client = await newGrpcConnection(
        cryptoPath,
        peerEndpoint,
        peerHostAlias
    );
    const identity = await newIdentity(userMspId, certDirectoryPath);
    const signer = await newSigner(keyDirectoryPath);

    const gateway = connect({
        client,
        identity,
        signer,
        hash: hash.sha256,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 5000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    const network = gateway.getNetwork(channelName);
    const contract = network.getContract(chaincodeName);

    return { contract, gateway };
}

// --- API Endpoints ---

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send(
        'Fertilizer Supply Chain Fabric API Server is running!'
    );
});

/**
 * Initialize Ledger (usually run once for setup)
 * This operation can be performed by any authorized user, e.g., 'supplier'.
 * This will now call the InitLedger from your AssetTransfer chaincode.
 * Request Body:
 * { "userType": "supplier" }
 */
app.post('/api/init-ledger', async (req, res) => {
    const { userType } = req.body;
    if (!userType) {
        return res
            .status(400)
            .json({ error: 'Missing userType in request body.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(`\n--> API Call: InitLedger by ${userType}`);
        await contract.submitTransaction('InitLedger');
        res.status(200).json({
            message: 'Ledger initialized successfully with sample assets.',
        });
    } catch (error) {
        console.error(`Failed to initialize ledger for ${userType}:`, error);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close(); // Close the gateway connection after use
    }
});

/**
 * Supplier initiates a new delivery and registers a new fertilizer unit.
 * Uses Chaincode: InitDeliveryWithFertilizer
 *
 * Request Body:
 * {
 * "userType": "supplier",
 * "deliveryId": "D001",
 * "fertilizerId": "F001",
 * "productType": "UREA",
 * "quantity": 50,
 * "agrodealerOrg": "Org3MSP" // Only MSP ID needed now
 * }
 */
app.post('/api/delivery/initiate', async (req, res) => {
    const {
        userType,
        deliveryId,
        fertilizerId,
        productType,
        quantity,
        agrodealerOrg, // This is the MSP ID for the target agrodealer
    } = req.body;

    if (
        !userType ||
        !deliveryId ||
        !fertilizerId ||
        !productType ||
        !quantity ||
        !agrodealerOrg
    ) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(
            `\n--> API Call: InitDeliveryWithFertilizer by ${userType}`
        );
        // Note: 'quantity' is converted to string for chaincode consistency
        await contract.submitTransaction(
            'InitDeliveryWithFertilizer',
            deliveryId,
            fertilizerId,
            productType,
            String(quantity),
            agrodealerOrg // Pass only the MSP ID, chaincode will resolve friendly name
        );
        res.status(200).json({
            message: `Delivery ${deliveryId} initiated and Fertilizer ${fertilizerId} registered successfully.`,
        });
    } catch (error) {
        console.error(`Failed to submit transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Supplier adds more fertilizers to an existing, INITIATED delivery.
 * Uses Chaincode: AddFertilizerToDelivery
 *
 * Request Body:
 * {
 * "userType": "supplier",
 * "deliveryId": "D001",
 * "fertilizerId": "F002",
 * "productType": "DAP",
 * "quantity": 25
 * }
 */
app.post('/api/delivery/add-fertilizer', async (req, res) => {
    const { userType, deliveryId, fertilizerId, productType, quantity } =
        req.body;

    if (
        !userType ||
        !deliveryId ||
        !fertilizerId ||
        !productType ||
        !quantity
    ) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(`\n--> API Call: AddFertilizerToDelivery by ${userType}`);
        await contract.submitTransaction(
            'AddFertilizerToDelivery',
            deliveryId,
            fertilizerId,
            productType,
            String(quantity)
        );
        res.status(200).json({
            message: `Fertilizer ${fertilizerId} added to Delivery ${deliveryId} successfully.`,
        });
    } catch (error) {
        console.error(`Failed to submit transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Transfer a delivery from current owner (Supplier or Transporter) to the next owner.
 * The `userType` in the request body should match the *current* owner initiating the transfer.
 * Uses Chaincode: TransferDelivery
 *
 * Request Body (Supplier to Transporter):
 * {
 * "userType": "supplier",
 * "deliveryId": "D001",
 * "newOwnerOrg": "Org2MSP"
 * }
 *
 * Request Body (Transporter to Agrodealer):
 * {
 * "userType": "transporter",
 * "deliveryId": "D001",
 * "newOwnerOrg": "Org3MSP"
 * }
 */
app.post('/api/delivery/transfer', async (req, res) => {
    const { userType, deliveryId, newOwnerOrg } = req.body;

    if (!userType || !deliveryId || !newOwnerOrg) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(`\n--> API Call: TransferDelivery by ${userType}`);
        await contract.submitTransaction(
            'TransferDelivery',
            deliveryId,
            newOwnerOrg // Pass only the MSP ID, chaincode will resolve friendly name
        );
        res.status(200).json({
            message: `Delivery ${deliveryId} transfer initiated to ${newOwnerOrg}.`,
        });
    } catch (error) {
        console.error(`Failed to submit transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * The receiving party (Transporter or Agrodealer) accepts a delivery.
 * The `userType` in the request body should match the *accepting* party.
 * Uses Chaincode: AcceptDelivery
 *
 * Request Body (Transporter Accepts):
 * {
 * "userType": "transporter",
 * "deliveryId": "D001",
 * "scannedFertilizerIds": ["F001", "F002"]
 * }
 *
 * Request Body (Agrodealer Accepts):
 * {
 * "userType": "agrodealer",
 * "deliveryId": "D001",
 * "scannedFertilizerIds": ["F001", "F002"]
 * }
 */
app.post('/api/delivery/accept', async (req, res) => {
    const { userType, deliveryId, scannedFertilizerIds } = req.body;

    if (
        !userType ||
        !deliveryId ||
        !scannedFertilizerIds ||
        !Array.isArray(scannedFertilizerIds)
    ) {
        return res.status(400).json({
            error: 'Missing required parameters or scannedFertilizerIds is not an array.',
        });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(`\n--> API Call: AcceptDelivery by ${userType}`);
        const scannedFertilizerIdsJson = JSON.stringify(scannedFertilizerIds); // Chaincode expects JSON string
        await contract.submitTransaction(
            'AcceptDelivery',
            deliveryId,
            scannedFertilizerIdsJson
        );
        res.status(200).json({
            message: `Delivery ${deliveryId} accepted successfully by ${userType}.`,
        });
    } catch (error) {
        console.error(`Failed to submit transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Query Fertilizer History.
 * Any authorized user can query.
 * Uses Chaincode: GetFertilizerHistory
 *
 * Query Parameters:
 * ?userType=supplier
 */
app.get('/api/fertilizer/:fertilizerId/history', async (req, res) => {
    const { fertilizerId } = req.params;
    const { userType } = req.query; // Expect userType from query for GET requests

    if (!userType || !fertilizerId) {
        return res
            .status(400)
            .json({ error: 'Missing userType or fertilizerId parameter.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(
            `\n--> API Call: GetFertilizerHistory for ${fertilizerId} by ${userType}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'GetFertilizerHistory',
            fertilizerId
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        console.error(`Failed to evaluate transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Query a single Fertilizer.
 * Any authorized user can query.
 * Uses Chaincode: ReadFertilizer
 *
 * Query Parameters:
 * ?userType=supplier
 */
app.get('/api/fertilizer/:fertilizerId', async (req, res) => {
    const { fertilizerId } = req.params;
    const { userType } = req.query;

    if (!userType || !fertilizerId) {
        return res
            .status(400)
            .json({ error: 'Missing userType or fertilizerId parameter.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(
            `\n--> API Call: ReadFertilizer for ${fertilizerId} by ${userType}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'ReadFertilizer',
            fertilizerId
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        if (error.message.includes('does not exist')) {
            res.status(404).json({
                error: `Fertilizer ${fertilizerId} not found.`,
            });
        } else {
            console.error(`Failed to evaluate transaction: ${error}`);
            res.status(500).json({ error: error.message });
        }
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Query a single Delivery.
 * Any authorized user can query.
 * Uses Chaincode: ReadDelivery
 *
 * Query Parameters:
 * ?userType=supplier
 */
app.get('/api/delivery/:deliveryId', async (req, res) => {
    const { deliveryId } = req.params;
    const { userType } = req.query;

    if (!userType || !deliveryId) {
        return res
            .status(400)
            .json({ error: 'Missing userType or deliveryId parameter.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(
            `\n--> API Call: ReadDelivery for ${deliveryId} by ${userType}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'ReadDelivery',
            deliveryId
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        if (error.message.includes('does not exist')) {
            res.status(404).json({
                error: `Delivery ${deliveryId} not found.`,
            });
        } else {
            console.error(`Failed to evaluate transaction: ${error}`);
            res.status(500).json({ error: error.message });
        }
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Query all fertilizers using a rich query.
 * Requires CouchDB.
 * Uses Chaincode: QueryAllFertilizers
 *
 * Request Body:
 * {
 * "userType": "supplier",
 * "queryString": "{\"selector\":{\"docType\":\"fertilizer\",\"currentOwnerOrg\":\"Org1MSP\"}}"
 * }
 */
app.post('/api/fertilizer/queryAll', async (req, res) => {
    const { userType, queryString } = req.body;

    if (!userType || !queryString) {
        return res
            .status(400)
            .json({ error: 'Missing userType or queryString parameter.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(
            `\n--> API Call: QueryAllFertilizers by ${userType} with query: ${queryString}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'QueryAllFertilizers',
            queryString
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        console.error(`Failed to evaluate transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

/**
 * Query all deliveries using a rich query.
 * Requires CouchDB.
 * Uses Chaincode: QueryAllDeliveries
 *
 * Request Body:
 * {
 * "userType": "supplier",
 * "queryString": "{\"selector\":{\"docType\":\"delivery\",\"status\":\"INITIATED\"}}"
 * }
 */
app.post('/api/delivery/queryAll', async (req, res) => {
    const { userType, queryString } = req.body;

    if (!userType || !queryString) {
        return res
            .status(400)
            .json({ error: 'Missing userType or queryString parameter.' });
    }

    let gateway;
    try {
        const { contract, gateway: gw } = await getFabricContract(userType);
        gateway = gw;
        console.log(
            `\n--> API Call: QueryAllDeliveries by ${userType} with query: ${queryString}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'QueryAllDeliveries',
            queryString
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        console.error(`Failed to evaluate transaction: ${error}`);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close();
    }
});

// Start the server
app.listen(port, async () => {
    console.log(`Fabric API server listening at http://localhost:${port}`);
    console.log(`Channel Name: ${channelName}`);
    console.log(`Chaincode Name: ${chaincodeName}`);
    console.log(`Org1 Crypto Path: ${cryptoPathOrg1}`);
    console.log(`Org2 Crypto Path: ${cryptoPathOrg2}`);
    console.log(`Org3 Crypto Path: ${cryptoPathOrg3}`);
    console.log(`Org1 Peer Endpoint: ${peerEndpointOrg1}`);
    console.log(`Org2 Peer Endpoint: ${peerEndpointOrg2}`);
    console.log(`Org3 Peer Endpoint: ${peerEndpointOrg3}`);
    console.log(
        'Using Admin users for simplified demonstration. Ensure Admin crypto materials are available at specified paths.'
    );
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});

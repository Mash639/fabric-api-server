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

// Middleware to parse JSON request bodies
app.use(bodyParser.json());

// --- Fabric Connection Configuration ---
const channelName = envOrDefault('CHANNEL_NAME', 'mychannel');
const chaincodeName = envOrDefault('CHAINCODE_NAME', 'basic'); // Ensure this matches your deployed chaincode name

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
    // Corrected line: Use orgPeerHostAlias directly to construct the path to the peer's TLS cert
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

/**
 * Main function to connect to Fabric Gateway and get a contract instance based on user's organization.
 * This function will establish a new connection for each request for simplicity,
 * but for production, you might want to manage a pool of connections or a single shared connection per organization.
 *
 * @param {string} userType Indicates which organization's user and crypto materials to use ('supplier', 'transporter', 'agrodealer').
 * @returns {Promise<{contract: import('@hyperledger/fabric-gateway').Contract, gateway: import('@hyperledger/fabric-gateway').Gateway}>} The Fabric contract and gateway instances.
 * @throws {Error} If connection fails or userType is invalid.
 */
async function getFabricContract(userType) {
    let cryptoPath,
        keyDirectoryPath,
        certDirectoryPath,
        tlsCertPath,
        peerEndpoint,
        peerHostAlias,
        userMspId;

    switch (userType.toLowerCase()) {
        case 'supplier':
            userMspId = 'Org1MSP'; // Adjust if your Supplier's MSP ID is different
            cryptoPath = cryptoPathOrg1;
            keyDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                'User1@org1.example.com',
                'msp',
                'keystore'
            );
            certDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                'User1@org1.example.com',
                'msp',
                'signcerts'
            );
            // tlsCertPath will be resolved within newGrpcConnection
            peerEndpoint = peerEndpointOrg1;
            peerHostAlias = 'peer0.org1.example.com';
            break;
        case 'transporter':
            userMspId = 'Org2MSP'; // Adjust if your Transporter's MSP ID is different
            cryptoPath = cryptoPathOrg2;
            keyDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                'User1@org2.example.com',
                'msp',
                'keystore'
            ); // Assuming User1 in Org2
            certDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                'User1@org2.example.com',
                'msp',
                'signcerts'
            ); // Assuming User1 in Org2
            // tlsCertPath will be resolved within newGrpcConnection
            peerEndpoint = peerEndpointOrg2;
            peerHostAlias = 'peer0.org2.example.com';
            break;
        case 'agrodealer':
            userMspId = 'Org3MSP'; // Adjust if your Agrodealer's MSP ID is different
            cryptoPath = cryptoPathOrg3;
            keyDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                'User1@org3.example.com',
                'msp',
                'keystore'
            ); // Assuming User1 in Org3
            certDirectoryPath = path.resolve(
                cryptoPath,
                'users',
                'User1@org3.example.com',
                'msp',
                'signcerts'
            ); // Assuming User1 in Org3
            // tlsCertPath will be resolved within newGrpcConnection
            peerEndpoint = peerEndpointOrg3;
            peerHostAlias = 'peer0.org3.example.com';
            break;
        default:
            throw new Error(
                `Invalid user type: ${userType}. Must be 'supplier', 'transporter', or 'agrodealer'.`
            );
    }

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
        res.status(200).json({ message: 'Ledger initialized successfully' });
    } catch (error) {
        console.error(`Failed to initialize ledger for ${userType}:`, error);
        res.status(500).json({ error: error.message });
    } finally {
        if (gateway) gateway.close(); // Close the gateway connection after use
    }
});

/**
 * 1. Supplier initiates a new delivery and registers a new fertilizer unit.
 *
 * Request Body:
 * {
 * "userType": "supplier",
 * "deliveryId": "D001",
 * "fertilizerId": "F001",
 * "productType": "UREA",
 * "quantity": 50,
 * "agrodealerOrg": "Org3MSP",
 * "agrodealerId": "x509::CN=User1@org3.example.com::L=Nairobi..."
 * }
 */
app.post('/api/delivery/initiate', async (req, res) => {
    const {
        userType,
        deliveryId,
        fertilizerId,
        productType,
        quantity,
        agrodealerOrg,
        agrodealerId,
    } = req.body;

    if (
        !userType ||
        !deliveryId ||
        !fertilizerId ||
        !productType ||
        !quantity ||
        !agrodealerOrg ||
        !agrodealerId
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
        await contract.submitTransaction(
            'InitDeliveryWithFertilizer',
            deliveryId,
            fertilizerId,
            productType,
            String(quantity), // Quantity is number in JS, but chaincode expects string
            agrodealerOrg,
            agrodealerId
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
 * 2. Supplier adds more fertilizers to an existing, INITIATED delivery.
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
 * 3. Transfer a delivery from current owner (Supplier or Transporter) to the next owner.
 * The `userType` in the request body should match the *current* owner initiating the transfer.
 *
 * Request Body (Supplier to Transporter):
 * {
 * "userType": "supplier",
 * "deliveryId": "D001",
 * "newOwnerOrg": "Org2MSP",
 * "newOwnerId": "x509::CN=User1@org2.example.com::L=Nairobi..."
 * }
 *
 * Request Body (Transporter to Agrodealer):
 * {
 * "userType": "transporter",
 * "deliveryId": "D001",
 * "newOwnerOrg": "Org3MSP",
 * "newOwnerId": "x509::CN=User1@org3.example.com::L=Nairobi..."
 * }
 */
app.post('/api/delivery/transfer', async (req, res) => {
    const { userType, deliveryId, newOwnerOrg, newOwnerId } = req.body;

    if (!userType || !deliveryId || !newOwnerOrg || !newOwnerId) {
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
            newOwnerOrg,
            newOwnerId
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
 * 4. The receiving party (Transporter or Agrodealer) accepts a delivery.
 * The `userType` in the request body should match the *accepting* party.
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
 * 5. Query Fertilizer History.
 * Any authorized user can query.
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
            `\n--> API Call: QueryFertilizer for ${fertilizerId} by ${userType}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'QueryFertilizer',
            fertilizerId
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        if (error.message.includes('does not exist')) {
            // Specific error message from chaincode
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
            `\n--> API Call: QueryDelivery for ${deliveryId} by ${userType}`
        );
        const resultBytes = await contract.evaluateTransaction(
            'QueryDelivery',
            deliveryId
        );
        const resultJson = utf8Decoder.decode(resultBytes);
        res.status(200).json(JSON.parse(resultJson));
    } catch (error) {
        if (error.message.includes('does not exist')) {
            // Specific error message from chaincode
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
        'Ensure crypto materials (private keys and certificates) are available at specified paths.'
    );
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    // No need to close shared gateway/client if they are created per request.
    // If you implemented connection pooling, you'd close the pool here.
    process.exit(0);
});

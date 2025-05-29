/*
 * Copyright IBM Corp. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

// Deterministic JSON.stringify()
const stringify = require('json-stringify-deterministic');
const sortKeysRecursive = require('sort-keys-recursive');
const { Contract } = require('fabric-contract-api');

/**
 * @typedef {object} FertilizerHistoryEntry
 * @property {string} timestamp
 * @property {string} actorOrg
 * @property {string} actorId
 * @property {string} action
 * @property {string} [previousOwnerOrg]
 * @property {string} [previousOwnerId]
 * @property {string} [newOwnerOrg]
 * @property {string} [newOwnerId]
 */

/**
 * @typedef {object} Fertilizer
 * @property {string} docType
 * @property {string} fertilizerId
 * @property {string} productType
 * @property {number} quantity
 * @property {string} currentOwnerOrg
 * @property {string} currentOwnerId
 * @property {string} [deliveryId]
 * @property {string} status
 * @property {FertilizerHistoryEntry[]} history
 */

/**
 * @typedef {object} Delivery
 * @property {string} docType
 * @property {string} deliveryId
 * @property {string} supplierOrg
 * @property {string} supplierId
 * @property {string} [currentTransporterOrg]
 * @property {string} [currentTransporterId]
 * @property {string} [agrodealerOrg]
 * @property {string} [agrodealerId]
 * @property {string[]} fertilizerIds
 * @property {string} status
 * @property {string} createdAt
 * @property {string} lastUpdated
 */

class AssetTransfer extends Contract {
    /**
     * @override
     * Chaincode Init function.
     * @param {Context} ctx The transaction context.
     */
    async InitLedger(ctx) {
        console.info(
            '============= START : Init Ledger for Fertilizer Supply Chain ==========='
        );
        // You can pre-populate some data here for testing, for example:

        const initialFertilizers = [
            {
                fertilizerId: 'F001',
                productType: 'UREA',
                quantity: 50,
                currentOwnerOrg: 'Org1MSP',
                currentOwnerId: 'x509::CN=User1@org1.example.com::L=Nairobi...',
                deliveryId: 'D001',
                status: 'REGISTERED',
                history: [],
            },
            // ... more fertilizers
        ];
        for (const fertilizer of initialFertilizers) {
            fertilizer.history.push({
                timestamp: this._getTimestamp(ctx),
                actorOrg: fertilizer.currentOwnerOrg,
                actorId: fertilizer.currentOwnerId,
                action: 'INITIAL_REGISTRATION',
                newOwnerOrg: fertilizer.currentOwnerOrg,
                newOwnerId: fertilizer.currentOwnerId,
            });
            await this._putFertilizer(ctx, fertilizer);
        }

        const initialDeliveries = [
            {
                deliveryId: 'D001',
                supplierOrg: 'Org1MSP',
                supplierId: 'x509::CN=User1@org1.example.com::L=Nairobi...',
                agrodealerOrg: 'Org3MSP',
                agrodealerId: 'x509::CN=User3@org3.example.com::L=Nairobi...',
                fertilizerIds: ['F001'],
                status: 'INITIATED',
                createdAt: this._getTimestamp(ctx),
                lastUpdated: this._getTimestamp(ctx),
            },
        ];
        for (const delivery of initialDeliveries) {
            await this._putDelivery(ctx, delivery);
        }

        console.info('============= END : Init Ledger ===========');
    }

    // --- Helper Functions (renamed from `private async` to `async` for JS, with `_` prefix for convention) ---

    /**
     * Helper to get client identity details.
     * @param {Context} ctx The transaction context.
     * @returns {object} Contains mspId and ID.
     */
    _getClientIdentity(ctx) {
        const clientIdentity = ctx.clientIdentity;
        return {
            mspId: clientIdentity.getMSPID(),
            id: clientIdentity.getID(), // e.g., 'x509::CN=User1@org1.example.com::L=Nairobi...'
        };
    }

    /**
     * Helper to get current transaction timestamp.
     * @param {Context} ctx The transaction context.
     * @returns {string} Timestamp in ISO format.
     */
    _getTimestamp(ctx) {
        // Fabric timestamps are in seconds since epoch. Convert to milliseconds for JS Date.
        const seconds = ctx.stub.getTxTimestamp().seconds.toNumber();
        return new Date(seconds * 1000).toISOString();
    }

    /**
     * Helper to retrieve a Fertilizer asset from the world state.
     * @param {Context} ctx The transaction context.
     * @param {string} fertilizerId The ID of the fertilizer.
     * @returns {Promise<Fertilizer>} The fertilizer object.
     * @throws {Error} If the fertilizer does not exist.
     */
    async _getFertilizer(ctx, fertilizerId) {
        const fertilizerBytes = await ctx.stub.getState(fertilizerId);
        if (!fertilizerBytes || fertilizerBytes.length === 0) {
            throw new Error(
                `Fertilizer with ID ${fertilizerId} does not exist`
            );
        }
        return JSON.parse(fertilizerBytes.toString());
    }

    /**
     * Helper to store a Fertilizer asset in the world state.
     * @param {Context} ctx The transaction context.
     * @param {Fertilizer} fertilizer The fertilizer object to store.
     */
    async _putFertilizer(ctx, fertilizer) {
        fertilizer.docType = 'fertilizer'; // For CouchDB indexing
        await ctx.stub.putState(
            fertilizer.fertilizerId,
            Buffer.from(stringify(sortKeysRecursive(fertilizer)))
        );
    }

    /**
     * Helper to retrieve a Delivery asset from the world state.
     * @param {Context} ctx The transaction context.
     * @param {string} deliveryId The ID of the delivery.
     * @returns {Promise<Delivery>} The delivery object.
     * @throws {Error} If the delivery does not exist.
     */
    async _getDelivery(ctx, deliveryId) {
        const deliveryBytes = await ctx.stub.getState(deliveryId);
        if (!deliveryBytes || deliveryBytes.length === 0) {
            throw new Error(`Delivery with ID ${deliveryId} does not exist`);
        }
        return JSON.parse(deliveryBytes.toString());
    }

    /**
     * Helper to store a Delivery asset in the world state.
     * @param {Context} ctx The transaction context.
     * @param {Delivery} delivery The delivery object to store.
     */
    async _putDelivery(ctx, delivery) {
        delivery.docType = 'delivery'; // For CouchDB indexing
        await ctx.stub.putState(
            delivery.deliveryId,
            Buffer.from(stringify(sortKeysRecursive(delivery)))
        );
    }

    // --- Core Transaction Functions ---

    /**
     * 1. Supplier initiates a new delivery and registers a new fertilizer unit.
     * This function combines `initDelivery` and `addFertilizerToDelivery` for the first unit.
     *
     * @param {Context} ctx The transaction context.
     * @param {string} deliveryId Unique ID for the new delivery.
     * @param {string} fertilizerId Unique ID for the first fertilizer in this delivery (QR code).
     * @param {string} productType Type of fertilizer (e.g., "DAP").
     * @param {number} quantity Quantity of this fertilizer unit (e.g., 50 kg).
     * @param {string} agrodealerOrg MSP ID of the target Agrodealer organization.
     * @param {string} agrodealerId User ID of the target Agrodealer.
     */
    async InitDeliveryWithFertilizer(
        ctx,
        deliveryId,
        fertilizerId,
        productType,
        quantity,
        agrodealerOrg,
        agrodealerId
    ) {
        const client = this._getClientIdentity(ctx);
        const supplierOrg = client.mspId;
        const supplierId = client.id;
        const timestamp = this._getTimestamp(ctx);

        // Permission check: Only Supplier (Org1MSP) can initiate
        // IMPORTANT: Adjust 'Org1MSP' if your Supplier's MSP ID is different.
        if (supplierOrg !== 'Org1MSP') {
            throw new Error(
                `Caller ${supplierOrg} is not authorized to initiate deliveries.`
            );
        }

        // Check if Fertilizer already exists
        const fertilizerExistsBytes = await ctx.stub.getState(fertilizerId);
        if (fertilizerExistsBytes && fertilizerExistsBytes.length > 0) {
            throw new Error(
                `Fertilizer with ID ${fertilizerId} already exists.`
            );
        }

        // Create a new Fertilizer asset
        const newFertilizer = {
            fertilizerId: fertilizerId,
            productType: productType,
            quantity: Number(quantity),
            currentOwnerOrg: supplierOrg,
            currentOwnerId: supplierId,
            deliveryId: deliveryId, // Link to the new delivery
            status: 'REGISTERED', // Initial status: registered with supplier
            history: [
                {
                    timestamp: timestamp,
                    actorOrg: supplierOrg,
                    actorId: supplierId,
                    action: 'REGISTERED_AND_INITIATED_DELIVERY',
                    newOwnerOrg: supplierOrg,
                    newOwnerId: supplierId,
                },
            ],
        };
        await this._putFertilizer(ctx, newFertilizer);

        // Check if Delivery already exists
        const deliveryExistsBytes = await ctx.stub.getState(deliveryId);
        if (deliveryExistsBytes && deliveryExistsBytes.length > 0) {
            throw new Error(`Delivery with ID ${deliveryId} already exists.`);
        }

        // Create a new Delivery asset
        const newDelivery = {
            deliveryId: deliveryId,
            supplierOrg: supplierOrg,
            supplierId: supplierId,
            agrodealerOrg: agrodealerOrg,
            agrodealerId: agrodealerId,
            fertilizerIds: [fertilizerId], // Add the first fertilizer
            status: 'INITIATED', // Initial status: delivery created
            createdAt: timestamp,
            lastUpdated: timestamp,
        };
        await this._putDelivery(ctx, newDelivery);

        console.info(
            `Delivery ${deliveryId} initiated and Fertilizer ${fertilizerId} registered by ${supplierId}`
        );
    }

    /**
     * 2. Supplier adds more fertilizers to an existing, INITIATED delivery.
     *
     * @param {Context} ctx The transaction context.
     * @param {string} deliveryId ID of the existing delivery.
     * @param {string} fertilizerId Unique ID of the fertilizer to add.
     * @param {string} productType Type of fertilizer.
     * @param {number} quantity Quantity of this fertilizer unit.
     */
    async AddFertilizerToDelivery(
        ctx,
        deliveryId,
        fertilizerId,
        productType,
        quantity
    ) {
        const client = this._getClientIdentity(ctx);
        const supplierOrg = client.mspId;
        const supplierId = client.id;
        const timestamp = this._getTimestamp(ctx);

        // Permission check: Only Supplier (Org1MSP) can add to a delivery they initiated
        if (supplierOrg !== 'Org1MSP') {
            throw new Error(
                `Caller ${supplierOrg} is not authorized to add fertilizers to deliveries.`
            );
        }

        // Check if delivery exists and is in correct status
        const delivery = await this._getDelivery(ctx, deliveryId);
        if (delivery.supplierOrg !== supplierOrg) {
            throw new Error(
                `Delivery ${deliveryId} was not initiated by current supplier ${supplierOrg}`
            );
        }
        if (delivery.status !== 'INITIATED') {
            throw new Error(
                `Fertilizers can only be added to a delivery in 'INITIATED' status. Current status: ${delivery.status}`
            );
        }

        // Check if fertilizer already exists or is part of another delivery
        const fertilizerExistsBytes = await ctx.stub.getState(fertilizerId);
        if (fertilizerExistsBytes && fertilizerExistsBytes.length > 0) {
            throw new Error(
                `Fertilizer with ID ${fertilizerId} already exists or is already part of another delivery.`
            );
        }

        // Create new Fertilizer asset
        const newFertilizer = {
            fertilizerId: fertilizerId,
            productType: productType,
            quantity: Number(quantity),
            currentOwnerOrg: supplierOrg,
            currentOwnerId: supplierId,
            deliveryId: deliveryId, // Link to the existing delivery
            status: 'REGISTERED', // Still registered with supplier, but linked
            history: [
                {
                    timestamp: timestamp,
                    actorOrg: supplierOrg,
                    actorId: supplierId,
                    action: 'ADDED_TO_DELIVERY',
                    newOwnerOrg: supplierOrg,
                    newOwnerId: supplierId,
                },
            ],
        };
        await this._putFertilizer(ctx, newFertilizer);

        // Update delivery asset
        delivery.fertilizerIds.push(fertilizerId);
        delivery.lastUpdated = timestamp;
        await this._putDelivery(ctx, delivery);

        console.info(
            `Fertilizer ${fertilizerId} added to Delivery ${deliveryId} by ${supplierId}`
        );
    }

    /**
     * 3. Transfer a delivery from current owner (Supplier or Transporter) to the next owner.
     * This function marks the intent to transfer and updates the delivery status.
     * Actual ownership change happens on `AcceptDelivery`.
     *
     * @param {Context} ctx The transaction context.
     * @param {string} deliveryId ID of the delivery to transfer.
     * @param {string} newOwnerOrg MSP ID of the intended new owner (Transporter or Agrodealer).
     * @param {string} newOwnerId User ID of the intended new owner.
     */
    async TransferDelivery(ctx, deliveryId, newOwnerOrg, newOwnerId) {
        const client = this._getClientIdentity(ctx);
        const currentOwnerOrg = client.mspId;
        const currentOwnerId = client.id;
        const timestamp = this._getTimestamp(ctx);

        const delivery = await this._getDelivery(ctx, deliveryId);

        let expectedStatus;
        let newDeliveryStatus;
        let transferAction;
        let expectedNewOwnerOrg; // For permission checks on the *type* of new owner

        // Determine current phase and validate transition
        // Supplier (Org1MSP) to Transporter (Org2MSP)
        if (currentOwnerOrg === 'Org1MSP' && delivery.status === 'INITIATED') {
            expectedStatus = 'INITIATED';
            newDeliveryStatus = 'IN_TRANSIT_TO_TRANSPORTER';
            transferAction = 'TRANSFER_INITIATED_TO_TRANSPORTER';
            expectedNewOwnerOrg = 'Org2MSP'; // Transporter

            if (newOwnerOrg !== expectedNewOwnerOrg) {
                throw new Error(
                    `Cannot transfer delivery from Supplier to ${newOwnerOrg}. Expected Transporter (${expectedNewOwnerOrg}).`
                );
            }
            delivery.currentTransporterOrg = newOwnerOrg;
            delivery.currentTransporterId = newOwnerId;

            // Transporter (Org2MSP) to Agrodealer (Org3MSP)
        } else if (
            currentOwnerOrg === 'Org2MSP' &&
            delivery.status === 'TRANSFERRED_TO_TRANSPORTER'
        ) {
            expectedStatus = 'TRANSFERRED_TO_TRANSPORTER';
            newDeliveryStatus = 'IN_TRANSIT_TO_AGRODEALER';
            transferAction = 'TRANSFER_INITIATED_TO_AGRODEALER';
            expectedNewOwnerOrg = 'Org3MSP'; // Agrodealer

            if (newOwnerOrg !== expectedNewOwnerOrg) {
                throw new Error(
                    `Cannot transfer delivery from Transporter to ${newOwnerOrg}. Expected Agrodealer (${expectedNewOwnerOrg}).`
                );
            }
        } else {
            throw new Error(
                `Caller ${currentOwnerOrg} is not authorized or Delivery ${deliveryId} is not in a transferable state. Current status: ${delivery.status}`
            );
        }

        // Update fertilizer statuses for all units in this delivery to reflect 'in transit'
        for (const fertilizerId of delivery.fertilizerIds) {
            const fertilizer = await this._getFertilizer(ctx, fertilizerId);

            // Ensure the fertilizer's current owner is the party initiating the transfer
            if (fertilizer.currentOwnerOrg !== currentOwnerOrg) {
                throw new Error(
                    `Fertilizer ${fertilizerId} is not owned by the transferring party (${currentOwnerOrg}). Current owner: ${fertilizer.currentOwnerOrg}`
                );
            }

            fertilizer.status = 'IN_DELIVERY'; // Mark as in transit
            fertilizer.history.push({
                timestamp: timestamp,
                actorOrg: currentOwnerOrg,
                actorId: currentOwnerId,
                action: transferAction,
                previousOwnerOrg: fertilizer.currentOwnerOrg,
                previousOwnerId: fertilizer.currentOwnerId,
                newOwnerOrg: newOwnerOrg, // Intended new owner
                newOwnerId: newOwnerId, // Intended new owner
            });
            // Owner remains current until accepted by next party
            await this._putFertilizer(ctx, fertilizer);
        }

        // Update Delivery status
        delivery.status = newDeliveryStatus;
        delivery.lastUpdated = timestamp;
        await this._putDelivery(ctx, delivery);

        console.info(
            `Transfer of Delivery ${deliveryId} initiated by ${currentOwnerId} to ${newOwnerId}. Status: ${newDeliveryStatus}`
        );
    }

    /**
     * 4. The receiving party (Transporter or Agrodealer) accepts a delivery.
     * This function validates content and transfers ownership on-chain for each fertilizer.
     *
     * @param {Context} ctx The transaction context.
     * @param {string} deliveryId ID of the delivery to accept.
     * @param {string} scannedFertilizerIdsJson JSON string array of fertilizer IDs scanned by the acceptor.
     */
    async AcceptDelivery(ctx, deliveryId, scannedFertilizerIdsJson) {
        const client = this._getClientIdentity(ctx);
        const acceptorOrg = client.mspId;
        const acceptorId = client.id;
        const timestamp = this._getTimestamp(ctx);
        const scannedFertilizerIds = JSON.parse(scannedFertilizerIdsJson);

        const delivery = await this._getDelivery(ctx, deliveryId);

        let previousOwnerOrg;
        let previousOwnerId;
        let newDeliveryStatus;
        let acceptAction;

        // Determine transition based on current delivery status and acceptor
        // IMPORTANT: Adjust 'Org2MSP' for Transporter and 'Org3MSP' for Agrodealer if different.
        if (
            delivery.status === 'IN_TRANSIT_TO_TRANSPORTER' &&
            acceptorOrg === 'Org2MSP'
        ) {
            // Transporter accepting
            previousOwnerOrg = delivery.supplierOrg;
            previousOwnerId = delivery.supplierId;
            newDeliveryStatus = 'TRANSFERRED_TO_TRANSPORTER';
            acceptAction = 'RECEIVED_BY_TRANSPORTER';

            // Ensure this transporter is the one assigned
            if (delivery.currentTransporterId !== acceptorId) {
                throw new Error(
                    `Transporter ${acceptorId} is not assigned to accept delivery ${deliveryId}. Assigned: ${delivery.currentTransporterId}`
                );
            }
            delivery.currentTransporterOrg = acceptorOrg; // Confirm transporter org
            delivery.currentTransporterId = acceptorId; // Confirm transporter ID
        } else if (
            delivery.status === 'IN_TRANSIT_TO_AGRODEALER' &&
            acceptorOrg === 'Org3MSP'
        ) {
            // Agrodealer accepting
            previousOwnerOrg = delivery.currentTransporterOrg;
            previousOwnerId = delivery.currentTransporterId;
            newDeliveryStatus = 'COMPLETED'; // Final step of delivery
            acceptAction = 'RECEIVED_BY_AGRODEALER';

            // Ensure this agrodealer is the one for whom the delivery was intended
            if (delivery.agrodealerId !== acceptorId) {
                throw new Error(
                    `Agrodealer ${acceptorId} is not the intended recipient for delivery ${deliveryId}. Intended: ${delivery.agrodealerId}`
                );
            }
            delivery.agrodealerOrg = acceptorOrg; // Confirm agrodealer org
            delivery.agrodealerId = acceptorId; // Confirm agrodealer ID
        } else {
            throw new Error(
                `Caller ${acceptorOrg} not authorized or Delivery ${deliveryId} not in a valid 'in transit' state for acceptance. Current status: ${delivery.status}`
            );
        }

        // 1. Verify all expected fertilizers are scanned and match
        if (
            delivery.fertilizerIds.length !== scannedFertilizerIds.length ||
            !delivery.fertilizerIds.every((id) =>
                scannedFertilizerIds.includes(id)
            )
        ) {
            throw new Error(
                `Scanned fertilizers do not match expected contents of delivery ${deliveryId}. Expected count: ${delivery.fertilizerIds.length}, Scanned count: ${scannedFertilizerIds.length}.`
            );
        }

        // 2. Update ownership and status for each fertilizer unit
        for (const fertilizerId of delivery.fertilizerIds) {
            const fertilizer = await this._getFertilizer(ctx, fertilizerId);

            // Ensure the fertilizer's owner matches the previous owner indicated by the delivery status
            if (fertilizer.currentOwnerOrg !== previousOwnerOrg) {
                throw new Error(
                    `Fertilizer ${fertilizerId} owner mismatch for acceptance. Expected ${previousOwnerOrg}, found ${fertilizer.currentOwnerOrg}.`
                );
            }
            if (fertilizer.status !== 'IN_DELIVERY') {
                throw new Error(
                    `Fertilizer ${fertilizerId} is not marked as 'IN_DELIVERY' and cannot be accepted.`
                );
            }

            // Update ownership
            fertilizer.currentOwnerOrg = acceptorOrg;
            fertilizer.currentOwnerId = acceptorId;
            fertilizer.status =
                acceptorOrg === 'Org3MSP'
                    ? 'DELIVERED_TO_AGRODEALER'
                    : 'TRANSFERRED_TO_NEXT_PARTY';

            // Add history entry
            const historyEntry = {
                timestamp: timestamp,
                actorOrg: acceptorOrg,
                actorId: acceptorId,
                action: acceptAction,
                previousOwnerOrg: previousOwnerOrg,
                previousOwnerId: previousOwnerId,
                newOwnerOrg: acceptorOrg,
                newOwnerId: acceptorId,
            };
            fertilizer.history.push(historyEntry);
            await this._putFertilizer(ctx, fertilizer);
        }

        // 3. Update Delivery status
        delivery.status = newDeliveryStatus;
        delivery.lastUpdated = timestamp;
        await this._putDelivery(ctx, delivery);

        console.info(
            `Delivery ${deliveryId} accepted by ${acceptorId}. New status: ${newDeliveryStatus}`
        );
    }

    // --- Query Functions ---

    /**
     * Get the full transaction history of a single fertilizer unit.
     * @param {Context} ctx The transaction context.
     * @param {string} fertilizerId The ID of the fertilizer.
     * @returns {Promise<string>} JSON string of the fertilizer's internal history array.
     */
    async GetFertilizerHistory(ctx, fertilizerId) {
        const fertilizer = await this._getFertilizer(ctx, fertilizerId);
        return JSON.stringify(fertilizer.history);
    }

    /**
     * Query to get a single Fertilizer asset.
     * @param {Context} ctx The transaction context.
     * @param {string} fertilizerId The ID of the fertilizer.
     * @returns {Promise<string>} JSON string of the fertilizer asset.
     */
    async QueryFertilizer(ctx, fertilizerId) {
        const fertilizerBytes = await ctx.stub.getState(fertilizerId);
        if (!fertilizerBytes || fertilizerBytes.length === 0) {
            throw new Error(`Fertilizer ${fertilizerId} does not exist`);
        }
        return fertilizerBytes.toString();
    }

    /**
     * Query to get a single Delivery asset.
     * @param {Context} ctx The transaction context.
     * @param {string} deliveryId The ID of the delivery.
     * @returns {Promise<string>} JSON string of the delivery asset.
     */
    async QueryDelivery(ctx, deliveryId) {
        const deliveryBytes = await ctx.stub.getState(deliveryId);
        if (!deliveryBytes || deliveryBytes.length === 0) {
            throw new Error(`Delivery ${deliveryId} does not exist`);
        }
        return deliveryBytes.toString();
    }

    /**
     * Helper for rich queries (CouchDB required).
     * @param {Context} ctx The transaction context.
     * @param {string} queryString The CouchDB query string.
     * @returns {Promise<string>} JSON string of query results.
     */
    async _getQueryResultForQueryString(ctx, queryString) {
        const iterator = await ctx.stub.getQueryResult(queryString);
        const results = [];
        let res = await iterator.next();
        while (!res.done) {
            if (res.value && res.value.value) {
                const json = JSON.parse(res.value.value.toString('utf8'));
                results.push(json);
            }
            res = await iterator.next();
        }
        // await iterator.destroy();
        return JSON.stringify(results);
    }

    /**
     * Query all fertilizers based on a simple selector (e.g., owner, status).
     * Requires CouchDB as state database.
     * @param {Context} ctx The transaction context.
     * @param {string} queryString JSON string representing the CouchDB selector query.
     * Example: `{"selector":{"docType":"fertilizer","currentOwnerOrg":"Org1MSP"}}`
     * Example: `{"selector":{"docType":"fertilizer","deliveryId":"delivery123"}}`
     * @returns {Promise<string>} JSON array of matching fertilizer assets.
     */
    async QueryAllFertilizers(ctx, queryString) {
        return this._getQueryResultForQueryString(ctx, queryString);
    }

    /**
     * Query all deliveries based on a simple selector.
     * Requires CouchDB as state database.
     * @param {Context} ctx The transaction context.
     * @param {string} queryString JSON string representing the CouchDB selector query.
     * Example: `{"selector":{"docType":"delivery","status":"INITIATED"}}`
     * @returns {Promise<string>} JSON array of matching delivery assets.
     */
    async QueryAllDeliveries(ctx, queryString) {
        return this._getQueryResultForQueryString(ctx, queryString);
    }
}

module.exports = AssetTransfer;

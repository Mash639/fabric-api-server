// assetTransfer.js - Updated Chaincode
'use strict';

const stringify = require('json-stringify-deterministic');
const sortKeysRecursive = require('sort-keys-recursive');
const { Contract } = require('fabric-contract-api');

class AssetTransfer extends Contract {
    async InitLedger(ctx) {
        console.info(
            'Initializing ledger with default organization entities...'
        );

        const orgEntities = [
            {
                orgId: 'Org1MSP',
                name: 'AgroChain Chemicals',
                role: 'Supplier',
                docType: 'organizationEntity',
            },
            {
                orgId: 'Org2MSP',
                name: 'AgroChain Logistics',
                role: 'Transporter',
                docType: 'organizationEntity',
            },
            {
                orgId: 'Org3MSP',
                name: 'AgroChain Dealers',
                role: 'Agrodealer',
                docType: 'organizationEntity',
            },
        ];

        for (const entity of orgEntities) {
            await ctx.stub.putState(
                entity.orgId,
                Buffer.from(stringify(sortKeysRecursive(entity)))
            );
            console.log(
                `Initialized organization entity: ${entity.name} (${entity.orgId})`
            );
        }
    }

    _getCallingOrgMspId(ctx) {
        return ctx.clientIdentity.getMSPID();
    }

    async _getOrgFriendlyName(ctx, orgId) {
        const orgEntityJSON = await ctx.stub.getState(orgId);
        if (!orgEntityJSON || orgEntityJSON.length === 0) {
            throw new Error(
                `Organization entity ${orgId} not found on ledger.`
            );
        }
        const orgEntity = JSON.parse(orgEntityJSON.toString());
        return orgEntity.name;
    }

    async InitDeliveryWithFertilizer(
        ctx,
        deliveryId,
        fertilizerId,
        productType,
        quantity,
        agrodealerOrg
    ) {
        const callingOrg = this._getCallingOrgMspId(ctx);
        if (callingOrg !== 'Org1MSP') {
            throw new Error(
                `Unauthorized: Only AgroChain Chemicals can initiate deliveries. Caller's Org: ${callingOrg}`
            );
        }

        const deliveryExists = await this._deliveryExists(ctx, deliveryId);
        if (deliveryExists) {
            throw new Error(`The delivery ${deliveryId} already exists`);
        }

        const fertilizerExists = await this._fertilizerExists(
            ctx,
            fertilizerId
        );
        if (fertilizerExists) {
            throw new Error(`The fertilizer ${fertilizerId} already exists`);
        }

        const supplierName = await this._getOrgFriendlyName(ctx, callingOrg);
        const agrodealerName = await this._getOrgFriendlyName(
            ctx,
            agrodealerOrg
        );

        const delivery = {
            deliveryId: deliveryId,
            docType: 'delivery',
            status: 'INITIATED',
            ownerOrg: callingOrg,
            ownerName: supplierName,
            targetOrg: agrodealerOrg,
            targetName: agrodealerName,
            fertilizerUnits: [
                {
                    fertilizerId: fertilizerId,
                    productType: productType,
                    quantity: parseInt(quantity),
                },
            ],
        };
        await ctx.stub.putState(
            deliveryId,
            Buffer.from(stringify(sortKeysRecursive(delivery)))
        );

        const fertilizer = {
            fertilizerId: fertilizerId,
            docType: 'fertilizer',
            productType: productType,
            quantity: parseInt(quantity),
            currentOwnerOrg: callingOrg,
            currentOwnerName: supplierName,
        };
        await ctx.stub.putState(
            fertilizerId,
            Buffer.from(stringify(sortKeysRecursive(fertilizer)))
        );

        return JSON.stringify(delivery);
    }

    async AddFertilizerToDelivery(
        ctx,
        deliveryId,
        fertilizerId,
        productType,
        quantity
    ) {
        const callingOrg = this._getCallingOrgMspId(ctx);

        const deliveryJSON = await ctx.stub.getState(deliveryId);
        if (!deliveryJSON || deliveryJSON.length === 0) {
            throw new Error(`The delivery ${deliveryId} does not exist`);
        }
        const delivery = JSON.parse(deliveryJSON.toString());

        if (delivery.ownerOrg !== callingOrg) {
            const callingOrgName = await this._getOrgFriendlyName(
                ctx,
                callingOrg
            );
            throw new Error(
                `Unauthorized: ${callingOrgName} (${callingOrg}) is not the current owner of delivery ${deliveryId}. Current owner: ${delivery.ownerName} (${delivery.ownerOrg})`
            );
        }

        const fertilizerExists = await this._fertilizerExists(
            ctx,
            fertilizerId
        );
        if (fertilizerExists) {
            throw new Error(`The fertilizer ${fertilizerId} already exists`);
        }

        const newFertilizer = {
            fertilizerId: fertilizerId,
            productType: productType,
            quantity: parseInt(quantity),
        };
        delivery.fertilizerUnits.push(newFertilizer);

        await ctx.stub.putState(
            deliveryId,
            Buffer.from(stringify(sortKeysRecursive(delivery)))
        );

        const fertilizer = {
            fertilizerId: fertilizerId,
            docType: 'fertilizer',
            productType: productType,
            quantity: parseInt(quantity),
            currentOwnerOrg: callingOrg,
            currentOwnerName: delivery.ownerName,
        };
        await ctx.stub.putState(
            fertilizerId,
            Buffer.from(stringify(sortKeysRecursive(fertilizer)))
        );

        return JSON.stringify(delivery);
    }

    async TransferDelivery(ctx, deliveryId, newOwnerOrg) {
        const callingOrg = this._getCallingOrgMspId(ctx);

        const deliveryJSON = await ctx.stub.getState(deliveryId);
        if (!deliveryJSON || deliveryJSON.length === 0) {
            throw new Error(`The delivery ${deliveryId} does not exist`);
        }
        const delivery = JSON.parse(deliveryJSON.toString());

        if (delivery.ownerOrg !== callingOrg) {
            const callingOrgName = await this._getOrgFriendlyName(
                ctx,
                callingOrg
            );
            throw new Error(
                `Unauthorized: ${callingOrgName} (${callingOrg}) is not the current owner of delivery ${deliveryId}. Current owner: ${delivery.ownerName} (${delivery.ownerOrg})`
            );
        }

        const newOwnerName = await this._getOrgFriendlyName(ctx, newOwnerOrg);

        delivery.status = 'TRANSFERRED';
        delivery.ownerOrg = newOwnerOrg;
        delivery.ownerName = newOwnerName;

        await ctx.stub.putState(
            deliveryId,
            Buffer.from(stringify(sortKeysRecursive(delivery)))
        );

        for (const unit of delivery.fertilizerUnits) {
            const fertilizerJSON = await ctx.stub.getState(unit.fertilizerId);
            if (fertilizerJSON && fertilizerJSON.length > 0) {
                const fertilizer = JSON.parse(fertilizerJSON.toString());
                fertilizer.currentOwnerOrg = newOwnerOrg;
                fertilizer.currentOwnerName = newOwnerName;
                await ctx.stub.putState(
                    unit.fertilizerId,
                    Buffer.from(stringify(sortKeysRecursive(fertilizer)))
                );
            }
        }

        return JSON.stringify(delivery);
    }

    async AcceptDelivery(ctx, deliveryId, scannedFertilizerIdsJson) {
        const callingOrg = this._getCallingOrgMspId(ctx);
        const scannedFertilizerIds = JSON.parse(scannedFertilizerIdsJson);

        const deliveryJSON = await ctx.stub.getState(deliveryId);
        if (!deliveryJSON || deliveryJSON.length === 0) {
            throw new Error(`The delivery ${deliveryId} does not exist`);
        }
        const delivery = JSON.parse(deliveryJSON.toString());

        if (delivery.status !== 'TRANSFERRED') {
            throw new Error(
                `Delivery ${deliveryId} is not in 'TRANSFERRED' status. Current status: ${delivery.status}`
            );
        }

        if (delivery.targetOrg !== callingOrg) {
            const callingOrgName = await this._getOrgFriendlyName(
                ctx,
                callingOrg
            );
            throw new Error(
                `Unauthorized: ${callingOrgName} (${callingOrg}) is not the designated recipient (${delivery.targetName}) for delivery ${deliveryId}.`
            );
        }

        const expectedFertilizerIds = delivery.fertilizerUnits.map(
            (unit) => unit.fertilizerId
        );
        const missingScanned = expectedFertilizerIds.filter(
            (id) => !scannedFertilizerIds.includes(id)
        );
        const extraScanned = scannedFertilizerIds.filter(
            (id) => !expectedFertilizerIds.includes(id)
        );

        if (missingScanned.length > 0) {
            throw new Error(
                `Missing expected fertilizers in scan: ${missingScanned.join(
                    ', '
                )}`
            );
        }
        if (extraScanned.length > 0) {
            throw new Error(
                `Extra fertilizers scanned not part of delivery: ${extraScanned.join(
                    ', '
                )}`
            );
        }

        delivery.status = 'ACCEPTED';
        delivery.ownerOrg = callingOrg;
        delivery.ownerName = await this._getOrgFriendlyName(ctx, callingOrg);
        delivery.targetOrg = '';
        delivery.targetName = '';

        await ctx.stub.putState(
            deliveryId,
            Buffer.from(stringify(sortKeysRecursive(delivery)))
        );

        for (const unit of delivery.fertilizerUnits) {
            const fertilizerJSON = await ctx.stub.getState(unit.fertilizerId);
            if (fertilizerJSON && fertilizerJSON.length > 0) {
                const fertilizer = JSON.parse(fertilizerJSON.toString());
                fertilizer.currentOwnerOrg = callingOrg;
                fertilizer.currentOwnerName = delivery.ownerName;
                await ctx.stub.putState(
                    unit.fertilizerId,
                    Buffer.from(stringify(sortKeysRecursive(fertilizer)))
                );
            }
        }

        return JSON.stringify(delivery);
    }

    async ReadDelivery(ctx, deliveryId) {
        const deliveryJSON = await ctx.stub.getState(deliveryId);
        if (!deliveryJSON || deliveryJSON.length === 0) {
            throw new Error(`The delivery ${deliveryId} does not exist`);
        }
        return deliveryJSON.toString();
    }

    async ReadFertilizer(ctx, fertilizerId) {
        const fertilizerJSON = await ctx.stub.getState(fertilizerId);
        if (!fertilizerJSON || fertilizerJSON.length === 0) {
            throw new Error(`The fertilizer ${fertilizerId} does not exist`);
        }
        return fertilizerJSON.toString();
    }

    async _deliveryExists(ctx, deliveryId) {
        const deliveryJSON = await ctx.stub.getState(deliveryId);
        return deliveryJSON && deliveryJSON.length > 0;
    }

    async _fertilizerExists(ctx, fertilizerId) {
        const fertilizerJSON = await ctx.stub.getState(fertilizerId);
        return fertilizerJSON && fertilizerJSON.length > 0;
    }

    /**
     * Performs a rich query to retrieve all fertilizers based on a CouchDB query string.
     * Rewritten to use the while (!result.done) pattern.
     * @param {Context} ctx The transaction context.
     * @param {string} queryString The CouchDB query string.
     * @returns {string} A JSON array of matching fertilizer assets.
     */
    async QueryAllFertilizers(ctx, queryString) {
        const resultsIterator = await ctx.stub.getQueryResult(queryString);
        const allResults = [];
        let result = await resultsIterator.next(); // Get the first result

        try {
            while (!result.done) {
                const strValue = Buffer.from(
                    result.value.value.toString()
                ).toString('utf8');
                let record;
                try {
                    record = JSON.parse(strValue);
                } catch (err) {
                    console.error(
                        `Error parsing JSON for key ${result.value.key}: ${err.message}`
                    );
                    record = strValue;
                }
                // Add key to the result object
                allResults.push({ Key: result.value.key, Record: record });
                result = await resultsIterator.next(); // Get the next result
            }
        } finally {
            await resultsIterator.close(); // Ensure iterator is closed
        }
        return JSON.stringify(allResults);
    }

    /**
     * Performs a rich query to retrieve all deliveries based on a CouchDB query string.
     * Rewritten to use the while (!result.done) pattern.
     * @param {Context} ctx The transaction context.
     * @param {string} queryString The CouchDB query string.
     * @returns {string} A JSON array of matching delivery assets.
     */
    async QueryAllDeliveries(ctx, queryString) {
        const resultsIterator = await ctx.stub.getQueryResult(queryString);
        const allResults = [];
        let result = await resultsIterator.next(); // Get the first result

        try {
            while (!result.done) {
                const strValue = Buffer.from(
                    result.value.value.toString()
                ).toString('utf8');
                let record;
                try {
                    record = JSON.parse(strValue);
                } catch (err) {
                    console.error(
                        `Error parsing JSON for key ${result.value.key}: ${err.message}`
                    );
                    record = strValue;
                }
                // Add key to the result object
                allResults.push({ Key: result.value.key, Record: record });
                result = await resultsIterator.next(); // Get the next result
            }
        } finally {
            await resultsIterator.close(); // Ensure iterator is closed
        }
        return JSON.stringify(allResults);
    }

    /**
     * Retrieves the history of a specific fertilizer unit.
     * Rewritten to use the while (!result.done) pattern.
     * @param {Context} ctx The transaction context.
     * @param {string} fertilizerId The ID of the fertilizer unit.
     * @returns {string} A JSON array of history records.
     */
    async GetFertilizerHistory(ctx, fertilizerId) {
        const exists = await this._fertilizerExists(ctx, fertilizerId);
        if (!exists) {
            throw new Error(`The fertilizer ${fertilizerId} does not exist`);
        }

        const resultsIterator = await ctx.stub.getHistoryForKey(fertilizerId);
        const allResults = [];
        let result = await resultsIterator.next(); // Get the first result

        try {
            while (!result.done) {
                const jsonRes = {};
                jsonRes.TxId = result.value.tx_id; // Corrected: use result.value.tx_id
                jsonRes.Timestamp = result.value.timestamp; // Corrected: use result.value.timestamp
                jsonRes.IsDelete = result.value.is_delete; // Corrected: use result.value.is_delete

                if (result.value.value && result.value.value.length > 0) {
                    try {
                        jsonRes.Value = JSON.parse(
                            result.value.value.toString('utf8')
                        );
                    } catch (err) {
                        console.error(
                            `Error parsing JSON for TxId ${result.value.tx_id}: ${err.message}`
                        );
                        jsonRes.Value = result.value.value.toString('utf8');
                    }
                } else {
                    jsonRes.Value = null; // Asset was deleted at this point
                }
                allResults.push(jsonRes);
                result = await resultsIterator.next(); // Get the next result
            }
        } finally {
            await resultsIterator.close(); // Ensure iterator is closed
        }
        return JSON.stringify(allResults);
    }
}

module.exports = AssetTransfer;

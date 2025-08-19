// This is a patch file showing the improved sendData logic
// It would replace the existing _sendDataInternal and sendData methods

/**
 * Internal method to send data through data channels with improved routing
 * @private
 * @param {*} data - Data to send
 * @param {string} uuid - Target UUID (optional)
 * @param {string} type - Connection type filter: 'viewer', 'publisher', or null
 * @param {string} preference - Channel preference: 'publisher', 'viewer', 'any', 'all'
 * @param {boolean} allowFallback - Whether to use WebSocket fallback
 */
_sendDataInternalImproved(data, uuid = null, type = null, preference = 'publisher', allowFallback = false) {
    let sent = false;
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    const sentConnections = new Set(); // Track which connections we've sent to

    if (uuid && !type) {
        // When UUID is specified but no type, use preference to determine order
        const connections = this.connections.get(uuid);
        if (connections) {
            const tryConnection = (connType) => {
                const conn = connections[connType];
                if (conn && conn.dataChannel && 
                    conn.dataChannel.readyState === 'open' &&
                    !sentConnections.has(conn)) {
                    try {
                        this._logMessage('OUT', data, 'DataChannel');
                        conn.dataChannel.send(message);
                        sentConnections.add(conn);
                        sent = true;
                        this._log(`Sent to ${uuid} via ${connType} connection`);
                        return true;
                    } catch (error) {
                        this._log(`Error sending via ${connType} connection:`, error);
                    }
                }
                return false;
            };

            if (preference === 'publisher') {
                // Try publisher first, then viewer if needed
                if (!tryConnection('publisher')) {
                    tryConnection('viewer');
                }
            } else if (preference === 'viewer') {
                // Try viewer first, then publisher if needed
                if (!tryConnection('viewer')) {
                    tryConnection('publisher');
                }
            } else if (preference === 'any') {
                // Try publisher first (as default), then viewer
                if (!tryConnection('publisher')) {
                    tryConnection('viewer');
                }
            } else if (preference === 'all') {
                // Send to both connections if they exist
                tryConnection('publisher');
                tryConnection('viewer');
            }
        }
    } else {
        // Get connections based on filters
        const connections = this._getConnections({ uuid, type });
        
        if (preference === 'all') {
            // Send to all matching connections
            for (const connection of connections) {
                if (connection && connection.dataChannel && 
                    connection.dataChannel.readyState === 'open' &&
                    !sentConnections.has(connection)) {
                    try {
                        this._logMessage('OUT', data, 'DataChannel');
                        connection.dataChannel.send(message);
                        sentConnections.add(connection);
                        sent = true;
                    } catch (error) {
                        this._log('Error sending data:', error);
                    }
                }
            }
        } else {
            // Group connections by UUID to avoid duplicates
            const connectionsByUuid = new Map();
            for (const conn of connections) {
                if (!connectionsByUuid.has(conn.uuid)) {
                    connectionsByUuid.set(conn.uuid, {});
                }
                connectionsByUuid.get(conn.uuid)[conn.type] = conn;
            }

            // Send to each UUID using preference
            for (const [connUuid, conns] of connectionsByUuid) {
                const tryConnection = (connType) => {
                    const conn = conns[connType];
                    if (conn && conn.dataChannel && 
                        conn.dataChannel.readyState === 'open' &&
                        !sentConnections.has(conn)) {
                        try {
                            this._logMessage('OUT', data, 'DataChannel');
                            conn.dataChannel.send(message);
                            sentConnections.add(conn);
                            sent = true;
                            return true;
                        } catch (error) {
                            this._log('Error sending data:', error);
                        }
                    }
                    return false;
                };

                if (preference === 'publisher') {
                    if (!tryConnection('publisher')) {
                        tryConnection('viewer');
                    }
                } else if (preference === 'viewer') {
                    if (!tryConnection('viewer')) {
                        tryConnection('publisher');
                    }
                } else { // 'any' or default
                    if (!tryConnection('publisher')) {
                        tryConnection('viewer');
                    }
                }
            }
        }
    }

    // Fallback to WebSocket if needed
    if (!sent && allowFallback && this.state.connected && this.signaling && this.signaling.readyState === WebSocket.OPEN) {
        try {
            const fallbackMsg = {
                ...data,
                __fallback: true
            };
            
            if (uuid) {
                fallbackMsg.UUID = uuid;
            }
            
            this._sendMessageWS(fallbackMsg);
            sent = true;
            this._log(`Sent via WebSocket fallback${uuid ? ` to ${uuid}` : ''}`);
        } catch (error) {
            this._log('Error sending via WebSocket fallback:', error);
        }
    }

    return sent;
}

/**
 * Send data through data channels with improved routing control
 * @param {*} data - Data to send
 * @param {string|Object} target - Target specification:
 *   - String: UUID of target peer
 *   - Object with options:
 *     - uuid: Target peer UUID
 *     - type: 'viewer' or 'publisher' to filter connections
 *     - streamID: Target all connections for a stream
 *     - preference: 'publisher' (default), 'viewer', 'any', or 'all'
 *     - allowFallback: Enable WebSocket fallback
 * 
 * Examples:
 * - sendData(data) // Send to all via publisher connections (no duplicates)
 * - sendData(data, "uuid123") // Send to specific peer (publisher channel preferred)
 * - sendData(data, { preference: 'all' }) // Send via ALL connections (may duplicate)
 * - sendData(data, { uuid: "uuid123", preference: 'viewer' }) // Use viewer channel
 * - sendData(data, { type: 'publisher' }) // Send to all publisher connections
 */
sendDataImproved(data, target = null) {
    const msg = { pipe: data };
    let allowFallback = false;
    let preference = 'publisher'; // Default preference
    
    // Handle different parameter formats
    if (typeof target === 'string') {
        // Simple UUID string - use default preference
        return this._sendDataInternalImproved(msg, target, null, preference, allowFallback);
    } else if (typeof target === 'object' && target !== null) {
        // Extract options
        if (target.hasOwnProperty('allowFallback')) {
            allowFallback = target.allowFallback;
        }
        if (target.hasOwnProperty('preference')) {
            preference = target.preference;
        }
        
        // Options object
        if (target.uuid || target.type || target.streamID) {
            // If specific filters are provided, use the improved internal method
            const connections = this._getConnections(target);
            
            // Group by UUID to handle preference correctly
            const connectionsByUuid = new Map();
            for (const conn of connections) {
                if (!connectionsByUuid.has(conn.uuid)) {
                    connectionsByUuid.set(conn.uuid, []);
                }
                connectionsByUuid.get(conn.uuid).push(conn);
            }
            
            let sent = false;
            for (const [uuid, conns] of connectionsByUuid) {
                // For each UUID, send according to preference
                if (this._sendDataInternalImproved(msg, uuid, null, preference, allowFallback)) {
                    sent = true;
                }
            }
            
            return sent;
        }
    }
    
    // Default: send to all with preference
    return this._sendDataInternalImproved(msg, null, null, preference, allowFallback);
}
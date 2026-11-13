// Only forward declarations
/*
 *  Unix SMB/CIFS implementation.
 *  RPC client transport
 *  Copyright (C) Volker Lendecke 2009
 *  Copyright (C) Simo Sorce 2010
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

#ifndef _RPC_CLIENT_RPC_TRANSPORT_H_
#define _RPC_CLIENT_RPC_TRANSPORT_H_

#include "rpc_common.h"
/**
 * rpc_cli_transport defines a transport mechanism to ship rpc requests
 * asynchronously to a server and receive replies
 */

struct rpc_cli_transport {
    enum dcerpc_transport_t transport;

    /**
     * Trigger an async read from the server. May return a short read.
     */
    struct tevent_req *(*read_send)(TALLOC_CTX *mem_ctx,
                                    struct tevent_context *ev, uint8_t *data,
                                    size_t size, void *priv);
    /**
     * Get the result from the read_send operation.
     */
    NTSTATUS (*read_recv)(struct tevent_req *req, ssize_t *preceived);

    /**
     * Trigger an async write to the server. May return a short write.
     */
    struct tevent_req *(*write_send)(TALLOC_CTX *mem_ctx,
                                     struct tevent_context *ev,
                                     const uint8_t *data, size_t size,
                                     void *priv);
    /**
     * Get the result from the read_send operation.
     */
    NTSTATUS (*write_recv)(struct tevent_req *req, ssize_t *psent);

    /**
     * This is an optimization for the SMB transport. It models the
     * TransactNamedPipe API call: Send and receive data in one round
     * trip. The transport implementation is free to set this to NULL,
     * cli_pipe.c will fall back to the explicit write/read routines.
     */
    struct tevent_req *(*trans_send)(TALLOC_CTX *mem_ctx,
                                     struct tevent_context *ev,
                                     const uint8_t *data, size_t data_len,
                                     uint32_t max_rdata_len, void *priv);
    /**
     * Get the result from the trans_send operation.
     */
    NTSTATUS (*trans_recv)(struct tevent_req *req, TALLOC_CTX *mem_ctx,
                           uint8_t **prdata, uint32_t *prdata_len);

    bool (*is_connected)(void *priv);
    unsigned int (*set_timeout)(void *priv, unsigned int timeout);

    void *priv;
};
#endif /* _RPC_CLIENT_RPC_TRANSPORT_H_ */

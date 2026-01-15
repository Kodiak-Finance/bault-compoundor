import { Address, createPublicClient, createWalletClient, http, PublicClient, WalletClient } from "viem";
import { berachain } from "viem/chains";
import { PRIVATE_KEY, RPC_URL } from "./configuration";
import { privateKeyToAccount, PrivateKeyAccount } from "viem/accounts";

// RPC call counters
let multicallRequestCount = 0;
let nonMulticallRequestCount = 0;

// Get multicall address from Berachain chain data
const multicallAddress = berachain.contracts?.multicall3?.address as Address;

export function logRpcStats() {
    const total = multicallRequestCount + nonMulticallRequestCount;
    if (total > 0) {
        console.log(
            `[RPC Stats] Multicall: ${multicallRequestCount} | ` +
            `Normal: ${nonMulticallRequestCount} | ` +
            `Total: ${total}`
        );
    }
}

export const resetRpcStats = () => {
    multicallRequestCount = 0;
    nonMulticallRequestCount = 0;
};

async function handleRpcRequest(request: Request) {
    try {
        const body = await request.clone().json();
        const requests = Array.isArray(body) ? body : [body];

        for (const req of requests) {
            const method = req.method as string | undefined;
            const params0 = req.params?.[0];
            const toAddress = params0?.to?.toLowerCase();
            const callData = params0?.data;

            // Check if this is a multicall request
            const isMulticall =
                method === "eth_call" &&
                !!toAddress &&
                !!callData &&
                !!multicallAddress &&
                toAddress.toLowerCase() === multicallAddress.toLowerCase();

            if (isMulticall) {
                multicallRequestCount++;
            } else {
                nonMulticallRequestCount++;
            }
        }
    } catch {
        // Ignore parsing errors
    }
}

export const transport = http(RPC_URL, {
    onFetchRequest: (request) => handleRpcRequest(request),
});

export const getPublicClient = (): PublicClient => {
    return createPublicClient({
        chain: berachain,
        transport: http(RPC_URL, {
            onFetchRequest: (request) => handleRpcRequest(request),
        })

    });
}

export const getWalletClient = (): WalletClient => {
    if (!PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY is not set");
    }
    return createWalletClient({
        account: privateKeyToAccount(PRIVATE_KEY),
        chain: berachain,
        transport: http(RPC_URL, {
            onFetchRequest: (request) => handleRpcRequest(request),
        })
    });
}

export const getAccount = (): PrivateKeyAccount => {
    if (!PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY is not set");
    }
    return privateKeyToAccount(PRIVATE_KEY);
}

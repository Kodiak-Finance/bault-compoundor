import { Address } from "viem";
import { ENSO_API_KEY } from "./configuration";

export type Route = {
    tokenIn: string[]
    tokenOut: string[]
    protocol: string
    action: string
    primary: string | undefined
    internalRoutes: Route[] | undefined // optional
}
export type EnsoQuoteResponse = {
    gas: string
    amountOut: string
    priceImpact: number | undefined
    feeAmount: string[]
    createdAt: number
    tx: {
        data: string
        to: string
        from: string
        value: string
    }
    route: Route[]
}

/**
 * Fetches a swap quote from the Enso API.
 * @param chainId The chain ID for the swap.
 * @param tokenIn The address of the input token.
 * @param tokenOut The address of the output token (e.g., Kodiak Island address).
 * @param amount The amount of tokenIn to swap, as a string (wei).
 * @param fromAddress The address initiating the swap.
 * @param receiver The address receiving the output token.
 * @param spender The address to pull input token from.
 * @param slippage The acceptable slippage percentage (e.g., 0.5 for 0.5%).
 * @param logExtensive Log the full API response for debugging.
 * @returns An object containing the quote details or throws an error.
 */
export async function getEnsoQuote(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amount: string,
    fromAddress: Address,
    receiver: Address,
    spender: Address,
    slippage: number, // in bps
    logExtensive: boolean = false
) {
    // IMPORTANT: Ensure ENSO_API_KEY is set in your environment variables (e.g., .env file loaded by Bun)
    const api_key = ENSO_API_KEY;
    if (!api_key) {
        console.error("Error: ENSO_API_KEY environment variable is not set.");
        process.exit(1);
    }
    const baseUrl = 'https://api.enso.finance/api/v1/shortcuts/route';
    const url = new URL(baseUrl);
    url.searchParams.set('chainId', chainId.toString());
    url.searchParams.set('fromAddress', fromAddress);
    url.searchParams.set('receiver', receiver);
    url.searchParams.set('spender', spender);
    url.searchParams.set('tokenIn', tokenIn);
    url.searchParams.set('tokenOut', tokenOut);
    url.searchParams.set('amountIn', amount);
    url.searchParams.set('slippage', (slippage).toString());
    url.searchParams.set('routingStrategy', 'router');

    // console.log("Enso quote URL:", url.toString());

    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${api_key}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`Error fetching Enso quote: ${response.status} ${response.statusText}`, errorBody);
            throw new Error(`Failed to fetch Enso quote: ${response.status} ${errorBody}`);
        }

        const data: EnsoQuoteResponse = await response.json();

        if (logExtensive) {
            console.log("====== Enso swap quote =======");
            console.log(JSON.stringify(data, null, 2)); // Pretty print the JSON
            console.log("====== End of Enso swap quote =======");
        }

        // Adapt the return structure to be similar to OBQuoter if needed
        return data;
    } catch (error) {
        console.error("Error getting Enso quote:", error);
        // Re-throw or handle as appropriate for your script
        throw error; // Re-throwing allows calling code to handle it
    }
}

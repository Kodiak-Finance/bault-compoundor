export const BOUNTY_HELPER_ABI =[
    {
        "type": "constructor",
        "inputs": [
            {
                "name": "_baultFactory",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "_owner",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "_bountyFunder",
                "type": "address",
                "internalType": "address"
            }
        ],
        "stateMutability": "nonpayable"
    },
    {
        "type": "receive",
        "stateMutability": "payable"
    },
    {
        "type": "function",
        "name": "BGT",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address"
            }
        ],
        "stateMutability": "view"
    },
    {
        "type": "function",
        "name": "WBERA",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "address"
            }
        ],
        "stateMutability": "view"
    },
    {
        "type": "function",
        "name": "baultFactory",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract IBaultFactory"
            }
        ],
        "stateMutability": "view"
    },
    {
        "type": "function",
        "name": "bountyFunder",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract BountyFunder"
            }
        ],
        "stateMutability": "view"
    },
    {
        "type": "function",
        "name": "cancelOwnershipHandover",
        "inputs": [],
        "outputs": [],
        "stateMutability": "payable"
    },
    {
        "type": "function",
        "name": "claimBgt",
        "inputs": [
            {
                "name": "_bault",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "router",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "data",
                "type": "bytes",
                "internalType": "bytes"
            },
            {
                "name": "minAmountOut",
                "type": "uint256",
                "internalType": "uint256"
            },
            {
                "name": "bgtRecipient",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "excessRecipient",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [],
        "stateMutability": "payable"
    },
    {
        "type": "function",
        "name": "claimBgtWrapper",
        "inputs": [
            {
                "name": "_bault",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "bgtWrapper",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "router",
                "type": "address",
                "internalType": "address"
            },
            {
                "name": "data",
                "type": "bytes",
                "internalType": "bytes"
            },
            {
                "name": "minAmountOut",
                "type": "uint256",
                "internalType": "uint256"
            },
            {
                "name": "excessRecipient",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [],
        "stateMutability": "nonpayable"
    },
    {
        "type": "function",
        "name": "completeOwnershipHandover",
        "inputs": [
            {
                "name": "pendingOwner",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [],
        "stateMutability": "payable"
    },
    {
        "type": "function",
        "name": "owner",
        "inputs": [],
        "outputs": [
            {
                "name": "result",
                "type": "address",
                "internalType": "address"
            }
        ],
        "stateMutability": "view"
    },
    {
        "type": "function",
        "name": "ownershipHandoverExpiresAt",
        "inputs": [
            {
                "name": "pendingOwner",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [
            {
                "name": "result",
                "type": "uint256",
                "internalType": "uint256"
            }
        ],
        "stateMutability": "view"
    },
    {
        "type": "function",
        "name": "recoverERC20",
        "inputs": [
            {
                "name": "token",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [],
        "stateMutability": "nonpayable"
    },
    {
        "type": "function",
        "name": "renounceOwnership",
        "inputs": [],
        "outputs": [],
        "stateMutability": "payable"
    },
    {
        "type": "function",
        "name": "requestOwnershipHandover",
        "inputs": [],
        "outputs": [],
        "stateMutability": "payable"
    },
    {
        "type": "function",
        "name": "setBountyFunder",
        "inputs": [
            {
                "name": "_bountyFunder",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [],
        "stateMutability": "nonpayable"
    },
    {
        "type": "function",
        "name": "transferOwnership",
        "inputs": [
            {
                "name": "newOwner",
                "type": "address",
                "internalType": "address"
            }
        ],
        "outputs": [],
        "stateMutability": "payable"
    },
    {
        "type": "event",
        "name": "BountyFunderSet",
        "inputs": [
            {
                "name": "bountyFunder",
                "type": "address",
                "indexed": false,
                "internalType": "address"
            }
        ],
        "anonymous": false
    },
    {
        "type": "event",
        "name": "OwnershipHandoverCanceled",
        "inputs": [
            {
                "name": "pendingOwner",
                "type": "address",
                "indexed": true,
                "internalType": "address"
            }
        ],
        "anonymous": false
    },
    {
        "type": "event",
        "name": "OwnershipHandoverRequested",
        "inputs": [
            {
                "name": "pendingOwner",
                "type": "address",
                "indexed": true,
                "internalType": "address"
            }
        ],
        "anonymous": false
    },
    {
        "type": "event",
        "name": "OwnershipTransferred",
        "inputs": [
            {
                "name": "oldOwner",
                "type": "address",
                "indexed": true,
                "internalType": "address"
            },
            {
                "name": "newOwner",
                "type": "address",
                "indexed": true,
                "internalType": "address"
            }
        ],
        "anonymous": false
    },
    {
        "type": "error",
        "name": "AlreadyInitialized",
        "inputs": []
    },
    {
        "type": "error",
        "name": "NewOwnerIsZeroAddress",
        "inputs": []
    },
    {
        "type": "error",
        "name": "NoHandoverRequest",
        "inputs": []
    },
    {
        "type": "error",
        "name": "Reentrancy",
        "inputs": []
    },
    {
        "type": "error",
        "name": "Unauthorized",
        "inputs": []
    }
] as const;
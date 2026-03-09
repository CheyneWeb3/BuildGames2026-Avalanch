// src/abi/yetiVaultAbi.ts
export const HAUS_VAULT_ABI = [

  	{
  		"inputs": [],
  		"name": "acceptOwnership",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "tokenIn",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "tokenOut",
  				"type": "address"
  			},
  			{
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "allowPair",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "bytes4",
  				"name": "selector",
  				"type": "bytes4"
  			},
  			{
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "allowSelector",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "target",
  				"type": "address"
  			},
  			{
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "allowTarget",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"internalType": "uint64",
  				"name": "destSelector",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "destWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sessionSig",
  				"type": "bytes"
  			}
  		],
  		"name": "bridgeUsdcWithSessionSig",
  		"outputs": [
  			{
  				"internalType": "bytes32",
  				"name": "messageId",
  				"type": "bytes32"
  			}
  		],
  		"stateMutability": "payable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "uint64",
  				"name": "destSelector",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "destWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sig",
  				"type": "bytes"
  			}
  		],
  		"name": "bridgeUsdcWithSig",
  		"outputs": [
  			{
  				"internalType": "bytes32",
  				"name": "messageId",
  				"type": "bytes32"
  			}
  		],
  		"stateMutability": "payable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"components": [
  					{
  						"internalType": "bytes32",
  						"name": "messageId",
  						"type": "bytes32"
  					},
  					{
  						"internalType": "uint64",
  						"name": "sourceChainSelector",
  						"type": "uint64"
  					},
  					{
  						"internalType": "bytes",
  						"name": "sender",
  						"type": "bytes"
  					},
  					{
  						"internalType": "bytes",
  						"name": "data",
  						"type": "bytes"
  					},
  					{
  						"components": [
  							{
  								"internalType": "address",
  								"name": "token",
  								"type": "address"
  							},
  							{
  								"internalType": "uint256",
  								"name": "amount",
  								"type": "uint256"
  							}
  						],
  						"internalType": "struct Client.EVMTokenAmount[]",
  						"name": "destTokenAmounts",
  						"type": "tuple[]"
  					}
  				],
  				"internalType": "struct Client.Any2EVMMessage",
  				"name": "message",
  				"type": "tuple"
  			}
  		],
  		"name": "ccipReceive",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"internalType": "uint64",
  				"name": "epoch",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			},
  			{
  				"internalType": "uint256",
  				"name": "maxPerTx",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "total",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sig",
  				"type": "bytes"
  			}
  		],
  		"name": "configSessionTokenWithSig",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "address",
  				"name": "creditTo",
  				"type": "address"
  			}
  		],
  		"name": "depositFor",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "creditTo",
  				"type": "address"
  			}
  		],
  		"name": "depositNativeFor",
  		"outputs": [],
  		"stateMutability": "payable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			}
  		],
  		"name": "disableToken",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			}
  		],
  		"name": "enableToken",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "pause",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"internalType": "uint48",
  				"name": "expiry",
  				"type": "uint48"
  			},
  			{
  				"internalType": "uint32",
  				"name": "scopes",
  				"type": "uint32"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sig",
  				"type": "bytes"
  			}
  		],
  		"name": "registerSessionWithSig",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "setDestAllowed",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "maxPerTx_",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "maxTotal_",
  				"type": "uint256"
  			}
  		],
  		"name": "setGlobalCaps",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "op",
  				"type": "address"
  			},
  			{
  				"internalType": "bool",
  				"name": "enabled",
  				"type": "bool"
  			}
  		],
  		"name": "setOperator",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "uint64",
  				"name": "chainSelector",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "vaultAddr",
  				"type": "address"
  			},
  			{
  				"internalType": "bool",
  				"name": "enabled",
  				"type": "bool"
  			}
  		],
  		"name": "setRemoteVault",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "bool",
  				"name": "enforcePairs_",
  				"type": "bool"
  			},
  			{
  				"internalType": "bool",
  				"name": "enforceSelectors_",
  				"type": "bool"
  			}
  		],
  		"name": "setSwapGuards",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"components": [
  					{
  						"internalType": "address",
  						"name": "ownerWallet",
  						"type": "address"
  					},
  					{
  						"internalType": "address",
  						"name": "target",
  						"type": "address"
  					},
  					{
  						"internalType": "address",
  						"name": "tokenIn",
  						"type": "address"
  					},
  					{
  						"internalType": "address",
  						"name": "tokenOut",
  						"type": "address"
  					},
  					{
  						"internalType": "uint256",
  						"name": "maxIn",
  						"type": "uint256"
  					},
  					{
  						"internalType": "uint256",
  						"name": "minOut",
  						"type": "uint256"
  					},
  					{
  						"internalType": "uint256",
  						"name": "callValue",
  						"type": "uint256"
  					},
  					{
  						"internalType": "uint256",
  						"name": "deadline",
  						"type": "uint256"
  					},
  					{
  						"internalType": "bytes",
  						"name": "callData",
  						"type": "bytes"
  					}
  				],
  				"internalType": "struct YetiCashierVault.SwapReq",
  				"name": "r",
  				"type": "tuple"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sig",
  				"type": "bytes"
  			}
  		],
  		"name": "swapWithSig",
  		"outputs": [],
  		"stateMutability": "payable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "newOwner",
  				"type": "address"
  			}
  		],
  		"name": "transferOwnership",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "initialOwner",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "usdcToken",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "ccipRouter_",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "wNative_",
  				"type": "address"
  			}
  		],
  		"stateMutability": "nonpayable",
  		"type": "constructor"
  	},
  	{
  		"inputs": [],
  		"name": "ECDSAInvalidSignature",
  		"type": "error"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "uint256",
  				"name": "length",
  				"type": "uint256"
  			}
  		],
  		"name": "ECDSAInvalidSignatureLength",
  		"type": "error"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "bytes32",
  				"name": "s",
  				"type": "bytes32"
  			}
  		],
  		"name": "ECDSAInvalidSignatureS",
  		"type": "error"
  	},
  	{
  		"inputs": [],
  		"name": "InvalidShortString",
  		"type": "error"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			}
  		],
  		"name": "SafeERC20FailedOperation",
  		"type": "error"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "string",
  				"name": "str",
  				"type": "string"
  			}
  		],
  		"name": "StringTooLong",
  		"type": "error"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "uint64",
  				"name": "sourceSelector",
  				"type": "uint64"
  			},
  			{
  				"indexed": true,
  				"internalType": "bytes32",
  				"name": "messageId",
  				"type": "bytes32"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "creditedTo",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			}
  		],
  		"name": "CCIPReceived",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "uint64",
  				"name": "destSelector",
  				"type": "uint64"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "usdcSent",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "bytes32",
  				"name": "messageId",
  				"type": "bytes32"
  			},
  			{
  				"indexed": false,
  				"internalType": "address",
  				"name": "destWallet",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "nonceOrSessionNonce",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "usedSession",
  				"type": "bool"
  			}
  		],
  		"name": "CCIPSent",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "creditTo",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "amountReceived",
  				"type": "uint256"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "from",
  				"type": "address"
  			}
  		],
  		"name": "Deposited",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "DestAllowed",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [],
  		"name": "EIP712DomainChanged",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "maxPerTx",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "maxTotal",
  				"type": "uint256"
  			}
  		],
  		"name": "GlobalCapsSet",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "operator",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "enabled",
  				"type": "bool"
  			}
  		],
  		"name": "OperatorSet",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "previousOwner",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "newOwner",
  				"type": "address"
  			}
  		],
  		"name": "OwnershipTransferStarted",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "previousOwner",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "newOwner",
  				"type": "address"
  			}
  		],
  		"name": "OwnershipTransferred",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "tokenIn",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "tokenOut",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "PairAllowed",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "uint64",
  				"name": "chainSelector",
  				"type": "uint64"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "vault",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "enabled",
  				"type": "bool"
  			}
  		],
  		"name": "RemoteVaultSet",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "bytes4",
  				"name": "selector",
  				"type": "bytes4"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "SelectorAllowed",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint64",
  				"name": "epoch",
  				"type": "uint64"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint48",
  				"name": "expiry",
  				"type": "uint48"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint32",
  				"name": "scopes",
  				"type": "uint32"
  			}
  		],
  		"name": "SessionRegistered",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			}
  		],
  		"name": "SessionRevoked",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint64",
  				"name": "epoch",
  				"type": "uint64"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "maxPerTx",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "total",
  				"type": "uint256"
  			}
  		],
  		"name": "SessionTokenConfigured",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "target",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "tokenIn",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "address",
  				"name": "tokenOut",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "actualInUsed",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "actualOut",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "maxIn",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "minOut",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "bytes4",
  				"name": "selector",
  				"type": "bytes4"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "nonce",
  				"type": "uint256"
  			}
  		],
  		"name": "SwapExecuted",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "enforcePairs",
  				"type": "bool"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "enforceSelectors",
  				"type": "bool"
  			}
  		],
  		"name": "SwapGuardsSet",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "target",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "allowed",
  				"type": "bool"
  			}
  		],
  		"name": "TargetAllowed",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			}
  		],
  		"name": "TokenDisabled",
  		"type": "event"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint8",
  				"name": "decimals",
  				"type": "uint8"
  			}
  		],
  		"name": "TokenEnabled",
  		"type": "event"
  	},
  	{
  		"inputs": [],
  		"name": "unpause",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"anonymous": false,
  		"inputs": [
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"indexed": true,
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "uint256",
  				"name": "nonceOrSessionNonce",
  				"type": "uint256"
  			},
  			{
  				"indexed": false,
  				"internalType": "bool",
  				"name": "usedSession",
  				"type": "bool"
  			}
  		],
  		"name": "Withdrawn",
  		"type": "event"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sessionSig",
  				"type": "bytes"
  			}
  		],
  		"name": "withdrawNativeWithSessionSig",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sig",
  				"type": "bytes"
  			}
  		],
  		"name": "withdrawNativeWithSig",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "sessionKey",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sessionSig",
  				"type": "bytes"
  			}
  		],
  		"name": "withdrawWithSessionSig",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "ownerWallet",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "token",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "to",
  				"type": "address"
  			},
  			{
  				"internalType": "uint256",
  				"name": "amount",
  				"type": "uint256"
  			},
  			{
  				"internalType": "uint256",
  				"name": "deadline",
  				"type": "uint256"
  			},
  			{
  				"internalType": "bytes",
  				"name": "sig",
  				"type": "bytes"
  			}
  		],
  		"name": "withdrawWithSig",
  		"outputs": [],
  		"stateMutability": "nonpayable",
  		"type": "function"
  	},
  	{
  		"stateMutability": "payable",
  		"type": "receive"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "activeSessionKey",
  		"outputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "ccipRouter",
  		"outputs": [
  			{
  				"internalType": "contract IRouterClient",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "destAllowed",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "eip712Domain",
  		"outputs": [
  			{
  				"internalType": "bytes1",
  				"name": "fields",
  				"type": "bytes1"
  			},
  			{
  				"internalType": "string",
  				"name": "name",
  				"type": "string"
  			},
  			{
  				"internalType": "string",
  				"name": "version",
  				"type": "string"
  			},
  			{
  				"internalType": "uint256",
  				"name": "chainId",
  				"type": "uint256"
  			},
  			{
  				"internalType": "address",
  				"name": "verifyingContract",
  				"type": "address"
  			},
  			{
  				"internalType": "bytes32",
  				"name": "salt",
  				"type": "bytes32"
  			},
  			{
  				"internalType": "uint256[]",
  				"name": "extensions",
  				"type": "uint256[]"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "enforcePairs",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "enforceSelectors",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "globalMaxPerTx",
  		"outputs": [
  			{
  				"internalType": "uint256",
  				"name": "",
  				"type": "uint256"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "globalMaxTotal",
  		"outputs": [
  			{
  				"internalType": "uint256",
  				"name": "",
  				"type": "uint256"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "isOperator",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "nonces",
  		"outputs": [
  			{
  				"internalType": "uint256",
  				"name": "",
  				"type": "uint256"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "owner",
  		"outputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "pairAllowed",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "paused",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "pendingOwner",
  		"outputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "uint64",
  				"name": "",
  				"type": "uint64"
  			}
  		],
  		"name": "remoteEnabled",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "uint64",
  				"name": "",
  				"type": "uint64"
  			}
  		],
  		"name": "remoteVault",
  		"outputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "SCOPE_BRIDGE",
  		"outputs": [
  			{
  				"internalType": "uint32",
  				"name": "",
  				"type": "uint32"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "SCOPE_WITHDRAW",
  		"outputs": [
  			{
  				"internalType": "uint32",
  				"name": "",
  				"type": "uint32"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "bytes4",
  				"name": "",
  				"type": "bytes4"
  			}
  		],
  		"name": "selectorAllowed",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "uint64",
  				"name": "",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "sessionMaxPerTx",
  		"outputs": [
  			{
  				"internalType": "uint256",
  				"name": "",
  				"type": "uint256"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "uint64",
  				"name": "",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "sessionRemaining",
  		"outputs": [
  			{
  				"internalType": "uint256",
  				"name": "",
  				"type": "uint256"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "sessions",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "enabled",
  				"type": "bool"
  			},
  			{
  				"internalType": "uint48",
  				"name": "expiry",
  				"type": "uint48"
  			},
  			{
  				"internalType": "uint32",
  				"name": "scopes",
  				"type": "uint32"
  			},
  			{
  				"internalType": "uint64",
  				"name": "epoch",
  				"type": "uint64"
  			},
  			{
  				"internalType": "uint256",
  				"name": "nonce",
  				"type": "uint256"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			},
  			{
  				"internalType": "uint64",
  				"name": "",
  				"type": "uint64"
  			},
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "sessionTokenAllowed",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "targetAllowed",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "",
  				"type": "bool"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"name": "tokenConfig",
  		"outputs": [
  			{
  				"internalType": "bool",
  				"name": "enabled",
  				"type": "bool"
  			},
  			{
  				"internalType": "uint8",
  				"name": "decimals",
  				"type": "uint8"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "usdc",
  		"outputs": [
  			{
  				"internalType": "contract IERC20",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	},
  	{
  		"inputs": [],
  		"name": "wNative",
  		"outputs": [
  			{
  				"internalType": "address",
  				"name": "",
  				"type": "address"
  			}
  		],
  		"stateMutability": "view",
  		"type": "function"
  	}


] as const;

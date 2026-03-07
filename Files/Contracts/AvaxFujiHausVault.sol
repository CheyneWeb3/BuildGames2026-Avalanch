// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";

/*
The Haus Vault

  - Multi-token custody vault
  - Deposit emits actual received amount
  - Operator executes, user authorizes (owner-sig) OR session key (session-sig)
  - Sessions: withdraw + bridge only (1 active session per owner)
  - Session token limits configured per token (NO arrays, NO loops) => avoids Yul stack-deep
  - CCIP USDC rail: strict src selector + src vault verification
  - Swap support included but disabled by allowlists by default (owner-signed only)
  - Native wrap/unwrap: vault stores ONLY wNative (WAVAX/etc). Users can deposit native; withdraw native unwraps.

  Notes:
  - Credits/ledger live offchain (server/indexer). Vault is custody + authorization onchain.

  ccip avaxfuji 0xF694E193200268f9a4868e4Aa017A0118C9a8177 (selector avaxfuji 14767482510784806043 )
  usdc avaxfuji 0x5425890298aed601595a70AB815c96711a31Bc65   
  wavax: avaxfuji  0xA751D2226402F0d5124D407b7aD16ef3fd8A7862

  https://testnet.routescan.io/address/0xd5919043c1cab69e71717283bcd98075700a1c98/contract/43113/code
  https://testnet.snowscan.xyz/address/0x636f2F34DEBeAB0eeDDb7fAB1fFb6C0172E757eF#code
*/

interface IWETH {
  function deposit() external payable;
  function withdraw(uint256) external;
}

contract TheHausVault is EIP712 {
  using SafeERC20 for IERC20;

  address public owner;
  address public pendingOwner;

  modifier onlyOwner() {
    require(msg.sender == owner, "NOT_OWNER");
    _;
  }

  event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "BAD_OWNER");
    pendingOwner = newOwner;
    emit OwnershipTransferStarted(owner, newOwner);
  }

  function acceptOwnership() external {
    require(msg.sender == pendingOwner, "NOT_PENDING_OWNER");
    address prev = owner;
    owner = pendingOwner;
    pendingOwner = address(0);
    emit OwnershipTransferred(prev, owner);
  }

  bool public paused;
  modifier whenNotPaused() { require(!paused, "PAUSED"); _; }
  function pause() external onlyOwner { paused = true; }
  function unpause() external onlyOwner { paused = false; }

  uint256 private _locked = 1;
  modifier nonReentrant() {
    require(_locked == 1, "REENTRANT");
    _locked = 2;
    _;
    _locked = 1;
  }

  mapping(address => bool) public isOperator;
  modifier onlyOperator() { require(isOperator[msg.sender], "NOT_OPERATOR"); _; }
  event OperatorSet(address indexed operator, bool enabled);

  function setOperator(address op, bool enabled) external onlyOwner {
    isOperator[op] = enabled;
    emit OperatorSet(op, enabled);
  }

  struct TokenConfig { bool enabled; uint8 decimals; }
  mapping(address => TokenConfig) public tokenConfig;

  mapping(address => uint256) public globalMaxPerTx;
  mapping(address => uint256) public globalMaxTotal;

  event TokenEnabled(address indexed token, uint8 decimals);
  event TokenDisabled(address indexed token);
  event GlobalCapsSet(address indexed token, uint256 maxPerTx, uint256 maxTotal);

  function enableToken(address token) external onlyOwner {
    require(token != address(0), "BAD_TOKEN");
    uint8 dec = IERC20Metadata(token).decimals();
    tokenConfig[token] = TokenConfig({enabled: true, decimals: dec});
    emit TokenEnabled(token, dec);
  }

  function disableToken(address token) external onlyOwner {
    require(IERC20(token).balanceOf(address(this)) == 0, "VAULT_BAL_NOT_ZERO");
    tokenConfig[token].enabled = false;
    emit TokenDisabled(token);
  }

  function setGlobalCaps(address token, uint256 maxPerTx_, uint256 maxTotal_) external onlyOwner {
    globalMaxPerTx[token] = maxPerTx_;
    globalMaxTotal[token] = maxTotal_;
    emit GlobalCapsSet(token, maxPerTx_, maxTotal_);
  }

  mapping(address => mapping(address => bool)) public destAllowed; 
  event DestAllowed(address indexed ownerWallet, address indexed to, bool allowed);

  function setDestAllowed(address to, bool allowed) external whenNotPaused {
    require(to != address(0), "BAD_TO");
    destAllowed[msg.sender][to] = allowed;
    emit DestAllowed(msg.sender, to, allowed);
  }

  function _isAllowedDest(address ownerWallet, address to) internal view returns (bool) {
    return (to == ownerWallet) || destAllowed[ownerWallet][to];
  }

  mapping(address => uint256) public nonces;

  uint32 public constant SCOPE_WITHDRAW = 1 << 0;
  uint32 public constant SCOPE_BRIDGE   = 1 << 1;

  struct SessionMeta {
    bool enabled;
    uint48 expiry;
    uint32 scopes;
    uint64 epoch;
    uint256 nonce;
  }

  mapping(address => address) public activeSessionKey;                  
  mapping(address => mapping(address => SessionMeta)) public sessions; 

  mapping(address => mapping(address => mapping(uint64 => mapping(address => bool)))) public sessionTokenAllowed;
  mapping(address => mapping(address => mapping(uint64 => mapping(address => uint256)))) public sessionMaxPerTx;
  mapping(address => mapping(address => mapping(uint64 => mapping(address => uint256)))) public sessionRemaining;

  event SessionRegistered(address indexed ownerWallet, address indexed sessionKey, uint64 epoch, uint48 expiry, uint32 scopes);
  event SessionRevoked(address indexed ownerWallet, address indexed sessionKey);
  event SessionTokenConfigured(address indexed ownerWallet, address indexed sessionKey, uint64 epoch, address indexed token, bool allowed, uint256 maxPerTx, uint256 total);

  function _requireActiveSession(address ownerWallet, address sessionKey, uint32 requiredScope)
    internal view returns (SessionMeta storage s)
  {
    s = sessions[ownerWallet][sessionKey];
    require(s.enabled, "NO_SESSION");
    require(activeSessionKey[ownerWallet] == sessionKey, "NOT_ACTIVE_SESSION");
    require(uint48(block.timestamp) <= s.expiry, "SESSION_EXPIRED");
    require((s.scopes & requiredScope) != 0, "SCOPE_NOT_ALLOWED");
  }

  IERC20 public immutable usdc;
  IRouterClient public immutable ccipRouter;

  mapping(uint64 => address) public remoteVault; 
  mapping(uint64 => bool)    public remoteEnabled;

  modifier onlyCcipRouter() { require(msg.sender == address(ccipRouter), "NOT_CCIP_ROUTER"); _; }

  event RemoteVaultSet(uint64 indexed chainSelector, address indexed vault, bool enabled);

  function setRemoteVault(uint64 chainSelector, address vaultAddr, bool enabled) external onlyOwner {
    remoteVault[chainSelector] = vaultAddr;
    remoteEnabled[chainSelector] = enabled;
    emit RemoteVaultSet(chainSelector, vaultAddr, enabled);
  }

  mapping(address => bool) public targetAllowed;
  mapping(bytes4 => bool)  public selectorAllowed;
  mapping(address => mapping(address => bool)) public pairAllowed;
  bool public enforcePairs;
  bool public enforceSelectors;

  event TargetAllowed(address indexed target, bool allowed);
  event SelectorAllowed(bytes4 indexed selector, bool allowed);
  event PairAllowed(address indexed tokenIn, address indexed tokenOut, bool allowed);
  event SwapGuardsSet(bool enforcePairs, bool enforceSelectors);

  function allowTarget(address target, bool allowed) external onlyOwner {
    targetAllowed[target] = allowed;
    emit TargetAllowed(target, allowed);
  }

  function allowSelector(bytes4 selector, bool allowed) external onlyOwner {
    selectorAllowed[selector] = allowed;
    emit SelectorAllowed(selector, allowed);
  }

  function allowPair(address tokenIn, address tokenOut, bool allowed) external onlyOwner {
    pairAllowed[tokenIn][tokenOut] = allowed;
    emit PairAllowed(tokenIn, tokenOut, allowed);
  }

  function setSwapGuards(bool enforcePairs_, bool enforceSelectors_) external onlyOwner {
    enforcePairs = enforcePairs_;
    enforceSelectors = enforceSelectors_;
    emit SwapGuardsSet(enforcePairs_, enforceSelectors_);
  }

  address public immutable wNative;

  event Deposited(address indexed creditTo, address indexed token, uint256 amountReceived, address indexed from);
  event Withdrawn(address indexed ownerWallet, address indexed token, address indexed to, uint256 amount, uint256 nonceOrSessionNonce, bool usedSession);
  event CCIPSent(address indexed ownerWallet, uint64 indexed destSelector, address indexed token, uint256 usdcSent, bytes32 messageId, address destWallet, uint256 nonceOrSessionNonce, bool usedSession);
  event CCIPReceived(uint64 indexed sourceSelector, bytes32 indexed messageId, address indexed creditedTo, address token, uint256 amount);
  event SwapExecuted(address indexed ownerWallet, address indexed target, address indexed tokenIn, address tokenOut, uint256 actualInUsed, uint256 actualOut, uint256 maxIn, uint256 minOut, bytes4 selector, uint256 nonce);

  bytes32 private constant WITHDRAW_TYPEHASH =
    keccak256("Withdraw(address ownerWallet,address token,address to,uint256 amount,uint256 nonce,uint256 deadline)");

  bytes32 private constant REGISTER_SESSION_TYPEHASH =
    keccak256("RegisterSession(address ownerWallet,address sessionKey,uint64 newEpoch,uint48 expiry,uint32 scopes,uint256 nonce,uint256 deadline)");

  bytes32 private constant CONFIG_SESSION_TOKEN_TYPEHASH =
    keccak256("ConfigSessionToken(address ownerWallet,address sessionKey,uint64 epoch,address token,bool allowed,uint256 maxPerTx,uint256 total,uint256 nonce,uint256 deadline)");

  bytes32 private constant SESSION_WITHDRAW_TYPEHASH =
    keccak256("SessionWithdraw(address ownerWallet,address sessionKey,uint64 epoch,address token,address to,uint256 amount,uint256 sessionNonce,uint256 deadline)");

  bytes32 private constant BRIDGE_USDC_TYPEHASH =
    keccak256("BridgeUSDC(address ownerWallet,uint64 destSelector,address destWallet,uint256 amount,uint256 nonce,uint256 deadline)");

  bytes32 private constant SESSION_BRIDGE_USDC_TYPEHASH =
    keccak256("SessionBridgeUSDC(address ownerWallet,address sessionKey,uint64 epoch,uint64 destSelector,address destWallet,uint256 amount,uint256 sessionNonce,uint256 deadline)");

  bytes32 private constant SWAPCALL_TYPEHASH =
    keccak256("SwapCall(address ownerWallet,address target,address tokenIn,address tokenOut,uint256 maxIn,uint256 minOut,uint256 callValue,bytes32 callHash,uint256 nonce,uint256 deadline)");

  bytes32 private constant WITHDRAW_NATIVE_TYPEHASH =
    keccak256("WithdrawNative(address ownerWallet,address to,uint256 amount,uint256 nonce,uint256 deadline)");

  bytes32 private constant SESSION_WITHDRAW_NATIVE_TYPEHASH =
    keccak256("SessionWithdrawNative(address ownerWallet,address sessionKey,uint64 epoch,address to,uint256 amount,uint256 sessionNonce,uint256 deadline)");

  struct SwapReq {
    address ownerWallet;
    address target;
    address tokenIn;
    address tokenOut;
    uint256 maxIn;
    uint256 minOut;
    uint256 callValue;
    uint256 deadline;
    bytes callData;
  }

  constructor(
    address initialOwner,
    address usdcToken,
    address ccipRouter_,
    address wNative_
  )
    EIP712("TheHausVault", "3")
  {
    require(initialOwner != address(0), "BAD_OWNER");
    require(usdcToken != address(0), "BAD_USDC");
    require(ccipRouter_ != address(0), "BAD_CCIP");
    require(wNative_ != address(0), "BAD_WNATIVE");

    owner = initialOwner;
    usdc = IERC20(usdcToken);
    ccipRouter = IRouterClient(ccipRouter_);
    wNative = wNative_;
  }

  function depositFor(address token, uint256 amount, address creditTo)
    external whenNotPaused nonReentrant
  {
    require(tokenConfig[token].enabled, "TOKEN_DISABLED");
    require(creditTo != address(0), "BAD_CREDIT_TO");

    uint256 beforeBal = IERC20(token).balanceOf(address(this));
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    uint256 afterBal = IERC20(token).balanceOf(address(this));

    emit Deposited(creditTo, token, afterBal - beforeBal, msg.sender);
  }

  function depositNativeFor(address creditTo)
    external payable whenNotPaused nonReentrant
  {
    require(creditTo != address(0), "BAD_CREDIT_TO");
    require(msg.value > 0, "ZERO_VALUE");
    require(tokenConfig[wNative].enabled, "WNATIVE_DISABLED");

    IWETH(wNative).deposit{value: msg.value}();
    emit Deposited(creditTo, wNative, msg.value, msg.sender);
  }

  function withdrawWithSig(
    address ownerWallet,
    address token,
    address to,
    uint256 amount,
    uint256 deadline,
    bytes calldata sig
  ) external whenNotPaused onlyOperator nonReentrant {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(tokenConfig[token].enabled, "TOKEN_DISABLED");
    require(to != address(0), "BAD_TO");

    uint256 nonce = nonces[ownerWallet];
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(WITHDRAW_TYPEHASH, ownerWallet, token, to, amount, nonce, deadline))
    );
    require(ECDSA.recover(digest, sig) == ownerWallet, "BAD_SIG");
    nonces[ownerWallet] = nonce + 1;

    IERC20(token).safeTransfer(to, amount);
    emit Withdrawn(ownerWallet, token, to, amount, nonce, false);
  }

  function withdrawNativeWithSig(
    address ownerWallet,
    address to,
    uint256 amount,
    uint256 deadline,
    bytes calldata sig
  ) external whenNotPaused onlyOperator nonReentrant {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(to != address(0), "BAD_TO");
    require(amount > 0, "ZERO_AMOUNT");
    require(tokenConfig[wNative].enabled, "WNATIVE_DISABLED");

    uint256 nonce = nonces[ownerWallet];
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(WITHDRAW_NATIVE_TYPEHASH, ownerWallet, to, amount, nonce, deadline))
    );
    require(ECDSA.recover(digest, sig) == ownerWallet, "BAD_SIG");
    nonces[ownerWallet] = nonce + 1;

    IWETH(wNative).withdraw(amount);
    (bool ok, ) = to.call{value: amount}("");
    require(ok, "NATIVE_SEND_FAIL");

    emit Withdrawn(ownerWallet, wNative, to, amount, nonce, false);
  }

  function registerSessionWithSig(
    address ownerWallet,
    address sessionKey,
    uint48 expiry,
    uint32 scopes,
    uint256 deadline,
    bytes calldata sig
  ) external whenNotPaused onlyOperator nonReentrant {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(ownerWallet != address(0), "BAD_OWNERWALLET");
    require(sessionKey != address(0), "BAD_SESSIONKEY");
    require(expiry > uint48(block.timestamp), "BAD_EXPIRY");
    require(scopes != 0, "BAD_SCOPES");

    uint64 newEpoch = sessions[ownerWallet][sessionKey].epoch + 1;
    uint256 nonce = nonces[ownerWallet];

    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(REGISTER_SESSION_TYPEHASH, ownerWallet, sessionKey, newEpoch, expiry, scopes, nonce, deadline))
    );
    require(ECDSA.recover(digest, sig) == ownerWallet, "BAD_SIG");
    nonces[ownerWallet] = nonce + 1;

    address oldKey = activeSessionKey[ownerWallet];
    if (oldKey != address(0) && oldKey != sessionKey) {
      sessions[ownerWallet][oldKey].enabled = false;
      emit SessionRevoked(ownerWallet, oldKey);
    }

    activeSessionKey[ownerWallet] = sessionKey;

    SessionMeta storage s = sessions[ownerWallet][sessionKey];
    s.enabled = true;
    s.expiry = expiry;
    s.scopes = scopes;
    s.epoch = newEpoch;
    s.nonce = 0;

    emit SessionRegistered(ownerWallet, sessionKey, newEpoch, expiry, scopes);
  }

  function configSessionTokenWithSig(
    address ownerWallet,
    address sessionKey,
    uint64 epoch,
    address token,
    bool allowed,
    uint256 maxPerTx,
    uint256 total,
    uint256 deadline,
    bytes calldata sig
  ) external whenNotPaused onlyOperator nonReentrant {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(ownerWallet != address(0), "BAD_OWNERWALLET");
    require(sessionKey != address(0), "BAD_SESSIONKEY");
    require(token != address(0), "BAD_TOKEN");
    require(tokenConfig[token].enabled, "TOKEN_DISABLED");

    SessionMeta storage s = sessions[ownerWallet][sessionKey];
    require(s.enabled, "NO_SESSION");
    require(s.epoch == epoch, "BAD_EPOCH");

    if (allowed) {
      require(maxPerTx > 0 && total > 0, "BAD_LIMITS");
      require(maxPerTx <= total, "MAX_GT_TOTAL");

      uint256 g1 = globalMaxPerTx[token];
      uint256 g2 = globalMaxTotal[token];
      if (g1 != 0) require(maxPerTx <= g1, "OVER_GLOBAL_MAXPERTX");
      if (g2 != 0) require(total <= g2, "OVER_GLOBAL_MAXTOTAL");
    } else {
      maxPerTx = 0;
      total = 0;
    }

    uint256 nonce = nonces[ownerWallet];
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(
        CONFIG_SESSION_TOKEN_TYPEHASH,
        ownerWallet, sessionKey, epoch, token, allowed, maxPerTx, total, nonce, deadline
      ))
    );
    require(ECDSA.recover(digest, sig) == ownerWallet, "BAD_SIG");
    nonces[ownerWallet] = nonce + 1;

    sessionTokenAllowed[ownerWallet][sessionKey][epoch][token] = allowed;
    sessionMaxPerTx[ownerWallet][sessionKey][epoch][token] = maxPerTx;
    sessionRemaining[ownerWallet][sessionKey][epoch][token] = total;

    emit SessionTokenConfigured(ownerWallet, sessionKey, epoch, token, allowed, maxPerTx, total);
  }

  function withdrawWithSessionSig(
    address ownerWallet,
    address sessionKey,
    address token,
    address to,
    uint256 amount,
    uint256 deadline,
    bytes calldata sessionSig
  ) external whenNotPaused onlyOperator nonReentrant {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(tokenConfig[token].enabled, "TOKEN_DISABLED");
    require(to != address(0), "BAD_TO");
    require(_isAllowedDest(ownerWallet, to), "DEST_NOT_ALLOWED");

    SessionMeta storage s = _requireActiveSession(ownerWallet, sessionKey, SCOPE_WITHDRAW);
    uint64 epoch = s.epoch;

    require(sessionTokenAllowed[ownerWallet][sessionKey][epoch][token], "TOKEN_NOT_ALLOWED");
    uint256 mpt = sessionMaxPerTx[ownerWallet][sessionKey][epoch][token];
    uint256 rem = sessionRemaining[ownerWallet][sessionKey][epoch][token];
    require(amount <= mpt, "OVER_MAXPERTX");
    require(amount <= rem, "OVER_REMAINING");

    uint256 snonce = s.nonce;
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(SESSION_WITHDRAW_TYPEHASH, ownerWallet, sessionKey, epoch, token, to, amount, snonce, deadline))
    );
    require(ECDSA.recover(digest, sessionSig) == sessionKey, "BAD_SESSION_SIG");

    s.nonce = snonce + 1;
    sessionRemaining[ownerWallet][sessionKey][epoch][token] = rem - amount;

    IERC20(token).safeTransfer(to, amount);
    emit Withdrawn(ownerWallet, token, to, amount, snonce, true);
  }

  function withdrawNativeWithSessionSig(
    address ownerWallet,
    address sessionKey,
    address to,
    uint256 amount,
    uint256 deadline,
    bytes calldata sessionSig
  ) external whenNotPaused onlyOperator nonReentrant {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(to != address(0), "BAD_TO");
    require(amount > 0, "ZERO_AMOUNT");
    require(tokenConfig[wNative].enabled, "WNATIVE_DISABLED");
    require(_isAllowedDest(ownerWallet, to), "DEST_NOT_ALLOWED");

    SessionMeta storage s = _requireActiveSession(ownerWallet, sessionKey, SCOPE_WITHDRAW);
    uint64 epoch = s.epoch;

    require(sessionTokenAllowed[ownerWallet][sessionKey][epoch][wNative], "WNATIVE_NOT_ALLOWED");
    uint256 mpt = sessionMaxPerTx[ownerWallet][sessionKey][epoch][wNative];
    uint256 rem = sessionRemaining[ownerWallet][sessionKey][epoch][wNative];
    require(amount <= mpt, "OVER_MAXPERTX");
    require(amount <= rem, "OVER_REMAINING");

    uint256 snonce = s.nonce;
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(
        SESSION_WITHDRAW_NATIVE_TYPEHASH,
        ownerWallet, sessionKey, epoch, to, amount, snonce, deadline
      ))
    );
    require(ECDSA.recover(digest, sessionSig) == sessionKey, "BAD_SESSION_SIG");

    s.nonce = snonce + 1;
    sessionRemaining[ownerWallet][sessionKey][epoch][wNative] = rem - amount;

    IWETH(wNative).withdraw(amount);
    (bool ok, ) = to.call{value: amount}("");
    require(ok, "NATIVE_SEND_FAIL");

    emit Withdrawn(ownerWallet, wNative, to, amount, snonce, true);
  }

  function bridgeUsdcWithSig(
    address ownerWallet,
    uint64 destSelector,
    address destWallet,
    uint256 amount,
    uint256 deadline,
    bytes calldata sig
  ) external payable whenNotPaused onlyOperator nonReentrant returns (bytes32 messageId) {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(destWallet != address(0), "BAD_DEST_WALLET");
    require(remoteEnabled[destSelector], "DEST_DISABLED");

    uint256 nonce = nonces[ownerWallet];
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(BRIDGE_USDC_TYPEHASH, ownerWallet, destSelector, destWallet, amount, nonce, deadline))
    );
    require(ECDSA.recover(digest, sig) == ownerWallet, "BAD_SIG");
    nonces[ownerWallet] = nonce + 1;

    messageId = _ccipSendUsdc(destSelector, destWallet, amount);
    emit CCIPSent(ownerWallet, destSelector, address(usdc), amount, messageId, destWallet, nonce, false);
  }

  function bridgeUsdcWithSessionSig(
    address ownerWallet,
    address sessionKey,
    uint64 destSelector,
    address destWallet,
    uint256 amount,
    uint256 deadline,
    bytes calldata sessionSig
  ) external payable whenNotPaused onlyOperator nonReentrant returns (bytes32 messageId) {
    require(block.timestamp <= deadline, "SIG_EXPIRED");
    require(destWallet != address(0), "BAD_DEST_WALLET");
    require(remoteEnabled[destSelector], "DEST_DISABLED");
    require(_isAllowedDest(ownerWallet, destWallet), "DEST_NOT_ALLOWED");

    SessionMeta storage s = _requireActiveSession(ownerWallet, sessionKey, SCOPE_BRIDGE);
    uint64 epoch = s.epoch;
    address token = address(usdc);

    require(sessionTokenAllowed[ownerWallet][sessionKey][epoch][token], "USDC_NOT_ALLOWED");
    uint256 mpt = sessionMaxPerTx[ownerWallet][sessionKey][epoch][token];
    uint256 rem = sessionRemaining[ownerWallet][sessionKey][epoch][token];
    require(amount <= mpt, "OVER_MAXPERTX");
    require(amount <= rem, "OVER_REMAINING");

    uint256 snonce = s.nonce;
    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(SESSION_BRIDGE_USDC_TYPEHASH, ownerWallet, sessionKey, epoch, destSelector, destWallet, amount, snonce, deadline))
    );
    require(ECDSA.recover(digest, sessionSig) == sessionKey, "BAD_SESSION_SIG");

    s.nonce = snonce + 1;
    sessionRemaining[ownerWallet][sessionKey][epoch][token] = rem - amount;

    messageId = _ccipSendUsdc(destSelector, destWallet, amount);
    emit CCIPSent(ownerWallet, destSelector, token, amount, messageId, destWallet, snonce, true);
  }

function _ccipSendUsdc(uint64 destSelector, address destWallet, uint256 amount) internal returns (bytes32 messageId) {
    address dstVault = remoteVault[destSelector];
    require(dstVault != address(0), "NO_DST_VAULT");

    usdc.forceApprove(address(ccipRouter), 0);
    usdc.forceApprove(address(ccipRouter), amount);

    Client.EVMTokenAmount[] memory arr = new Client.EVMTokenAmount[](1);
    arr[0] = Client.EVMTokenAmount({token: address(usdc), amount: amount});

    Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
        receiver: abi.encode(dstVault),
        data: abi.encode(destWallet),
        tokenAmounts: arr,
        feeToken: address(0),
        extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: 200_000}))
    });

    messageId = ccipRouter.ccipSend{value: msg.value}(destSelector, m);
}

  function ccipReceive(Client.Any2EVMMessage calldata message)
    external
    whenNotPaused
    nonReentrant
  {
    require(msg.sender == address(ccipRouter), "NOT_CCIP_ROUTER");

    uint64 src = message.sourceChainSelector;
    require(remoteEnabled[src], "SRC_DISABLED");

    address expectedSrcVault = remoteVault[src];
    address actualSrcVault = abi.decode(message.sender, (address));
    require(actualSrcVault == expectedSrcVault, "BAD_SRC_VAULT");

    require(message.destTokenAmounts.length == 1, "BAD_TOKENS_LEN");
    Client.EVMTokenAmount calldata ta = message.destTokenAmounts[0];
    require(ta.token == address(usdc), "NOT_USDC");

    address creditedTo = abi.decode(message.data, (address));
    require(creditedTo != address(0), "BAD_CREDIT_TO");

    emit CCIPReceived(src, message.messageId, creditedTo, ta.token, ta.amount);
  }

  function swapWithSig(SwapReq calldata r, bytes calldata sig)
    external payable whenNotPaused onlyOperator nonReentrant
  {
    require(block.timestamp <= r.deadline, "SIG_EXPIRED");
    require(msg.value == r.callValue, "BAD_CALL_VALUE");
    require(targetAllowed[r.target], "TARGET_NOT_ALLOWED");
    require(tokenConfig[r.tokenIn].enabled, "TOKENIN_DISABLED");
    require(tokenConfig[r.tokenOut].enabled, "TOKENOUT_DISABLED");
    if (enforcePairs) require(pairAllowed[r.tokenIn][r.tokenOut], "PAIR_NOT_ALLOWED");

    require(r.callData.length >= 4, "CALLDATA_SHORT");
    bytes calldata cd = r.callData;

    bytes4 sel;
    assembly ("memory-safe") {
      sel := shr(224, calldataload(cd.offset))
    }

    if (enforceSelectors) require(selectorAllowed[sel], "SELECTOR_NOT_ALLOWED");

    bytes32 callHash = keccak256(r.callData);
    uint256 nonce = nonces[r.ownerWallet];

    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(
        SWAPCALL_TYPEHASH,
        r.ownerWallet,
        r.target,
        r.tokenIn,
        r.tokenOut,
        r.maxIn,
        r.minOut,
        r.callValue,
        callHash,
        nonce,
        r.deadline
      ))
    );
    require(ECDSA.recover(digest, sig) == r.ownerWallet, "BAD_SIG");
    nonces[r.ownerWallet] = nonce + 1;

    uint256 inBefore = IERC20(r.tokenIn).balanceOf(address(this));
    uint256 outBefore = IERC20(r.tokenOut).balanceOf(address(this));

    IERC20(r.tokenIn).forceApprove(r.target, 0);
    IERC20(r.tokenIn).forceApprove(r.target, r.maxIn);

    (bool ok, bytes memory ret) = r.target.call{value: r.callValue}(r.callData);

    IERC20(r.tokenIn).forceApprove(r.target, 0);

    if (!ok) {
      if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
      revert("SWAP_CALL_FAILED");
    }

    uint256 inAfter = IERC20(r.tokenIn).balanceOf(address(this));
    uint256 outAfter = IERC20(r.tokenOut).balanceOf(address(this));

    uint256 actualIn = inBefore - inAfter;
    uint256 actualOut = outAfter - outBefore;

    require(actualIn <= r.maxIn, "IN_OVER_MAX");
    require(actualOut >= r.minOut, "OUT_UNDER_MIN");

    emit SwapExecuted(r.ownerWallet, r.target, r.tokenIn, r.tokenOut, actualIn, actualOut, r.maxIn, r.minOut, sel, nonce);
  }

  receive() external payable {}
}

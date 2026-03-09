// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TunnelUrlRegistry10
 * - Store up to 10 public tunnel URLs (or endpoints) on-chain.
 * - Owner can set/change the operator.
 * - Operator (or owner) can update any tunnel slot when it changes.
 *
 * Slots:
 * - Use tunnelId in range [1..10]
 *
 * Notes:
 * - URLs are public on-chain (don’t store secrets).
 * - Updating strings costs gas; keep URLs short if possible.
 */
contract TunnelUrlRegistry10 {
    address public owner;
    address public operator;

    uint256 public constant MAX_TUNNELS = 1000;

    struct TunnelMeta {
        string url;
        uint64 updatedAt; // unix timestamp
        uint64 version;   // increments per tunnel update
    }

    mapping(uint256 => TunnelMeta) private _tunnels;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);

    event TunnelUpdated(
        uint256 indexed tunnelId,
        string previousUrl,
        string newUrl,
        address indexed updatedBy,
        uint256 updatedAt,
        uint256 version
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOperatorOrOwner() {
        require(msg.sender == operator || msg.sender == owner, "NOT_AUTH");
        _;
    }

    modifier validTunnel(uint256 tunnelId) {
        require(tunnelId >= 1 && tunnelId <= MAX_TUNNELS, "BAD_TUNNEL_ID");
        _;
    }

    constructor(address initialOperator) {
        owner = msg.sender;
        operator = initialOperator;

        emit OwnerTransferred(address(0), msg.sender);
        emit OperatorChanged(address(0), initialOperator);
    }

    // ----------------
    // Reads
    // ----------------

    function url(uint256 tunnelId) external view validTunnel(tunnelId) returns (string memory) {
        return _tunnels[tunnelId].url;
    }

    function getTunnel(uint256 tunnelId)
        external
        view
        validTunnel(tunnelId)
        returns (string memory currentUrl, uint256 lastUpdatedAt, uint256 currentVersion, address currentOperator)
    {
        TunnelMeta storage t = _tunnels[tunnelId];
        return (t.url, t.updatedAt, t.version, operator);
    }

    /// Read multiple tunnels in one call.
    function getTunnels(uint256[] calldata tunnelIds)
        external
        view
        returns (string[] memory urls_, uint256[] memory updatedAts_, uint256[] memory versions_)
    {
        uint256 n = tunnelIds.length;
        urls_ = new string[](n);
        updatedAts_ = new uint256[](n);
        versions_ = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 id = tunnelIds[i];
            require(id >= 1 && id <= MAX_TUNNELS, "BAD_TUNNEL_ID");

            TunnelMeta storage t = _tunnels[id];
            urls_[i] = t.url;
            updatedAts_[i] = t.updatedAt;
            versions_[i] = t.version;
        }
    }

    // ----------------
    // Writes
    // ----------------

    function setTunnelUrl(uint256 tunnelId, string calldata newUrl)
        external
        onlyOperatorOrOwner
        validTunnel(tunnelId)
    {
        require(bytes(newUrl).length > 0, "EMPTY_URL");

        TunnelMeta storage t = _tunnels[tunnelId];
        string memory prev = t.url;

        t.url = newUrl;
        t.updatedAt = uint64(block.timestamp);
        t.version = t.version + 1;

        emit TunnelUpdated(tunnelId, prev, newUrl, msg.sender, t.updatedAt, t.version);
    }

    /// Batch update (cheaper than multiple transactions, still costs per string write).
    function setTunnelUrls(uint256[] calldata tunnelIds, string[] calldata newUrls)
        external
        onlyOperatorOrOwner
    {
        uint256 n = tunnelIds.length;
        require(n == newUrls.length, "LEN_MISMATCH");
        require(n > 0, "EMPTY_BATCH");

        for (uint256 i = 0; i < n; i++) {
            uint256 id = tunnelIds[i];
            require(id >= 1 && id <= MAX_TUNNELS, "BAD_TUNNEL_ID");
            require(bytes(newUrls[i]).length > 0, "EMPTY_URL");

            TunnelMeta storage t = _tunnels[id];
            string memory prev = t.url;

            t.url = newUrls[i];
            t.updatedAt = uint64(block.timestamp);
            t.version = t.version + 1;

            emit TunnelUpdated(id, prev, newUrls[i], msg.sender, t.updatedAt, t.version);
        }
    }

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "ZERO_OPERATOR");
        address prev = operator;
        operator = newOperator;
        emit OperatorChanged(prev, newOperator);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        address prev = owner;
        owner = newOwner;
        emit OwnerTransferred(prev, newOwner);
    }
}

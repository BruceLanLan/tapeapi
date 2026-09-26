// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChannelBus: TAP-26 wire messages carried by the chain itself (TAP-26 §3.7)
/// @notice Emits one `Wire` event per wire message and stores nothing: no owner, no fee, no state, no upgrade.
///         Readers query `Wire` logs by room. The sender is not in the event: TAP-26 frames authenticate
///         themselves, so an extra topic would cost gas and add nothing.
/// @notice 由链本身承载 TAP-26 线路消息。每条消息发出一个 `Wire` 事件，不存储任何东西：无所有者、无费用、
///         无状态、不可升级。读取方按房间查询 `Wire` 日志。事件不含发送者：TAP-26 帧自带认证，多一个 topic 只费 gas。
contract ChannelBus {
    /// One TAP-26 frame (16 KiB of plaintext) plus wire framing and the AEAD tag / 一帧加封装与认证标签
    uint256 public constant MAX_WIRE = 16_448;
    /// Wire messages per `sendMany` / 每次 `sendMany` 的消息条数上限
    uint256 public constant MAX_BATCH = 16;

    event Wire(bytes32 indexed room, bytes wire);

    error EmptyWire();
    error WireTooLarge(uint256 length);
    error BadBatch();

    /// @notice Post one wire message to `room` / 向 `room` 发送一条线路消息
    function send(bytes32 room, bytes calldata wire) external {
        _post(room, wire);
    }

    /// @notice Post several wire messages to one room in one transaction, saving the per-transaction base cost
    ///         (for example `ready` and the first frame). `packed` is a sequence of `uint16 length ‖ wire`, big-endian.
    /// @notice 一笔交易向同一房间发送多条消息，省掉每笔交易的基础费用（例如 `ready` 与第一帧一起发）。
    ///         `packed` 为若干 `uint16 长度 ‖ 消息`，大端。
    function sendMany(bytes32 room, bytes calldata packed) external {
        uint256 at;
        uint256 n;
        while (at < packed.length) {
            if (at + 2 > packed.length || ++n > MAX_BATCH) revert BadBatch();
            uint256 len = (uint256(uint8(packed[at])) << 8) | uint256(uint8(packed[at + 1]));
            at += 2;
            if (at + len > packed.length) revert BadBatch();
            _post(room, packed[at:at + len]);
            at += len;
        }
        if (n == 0) revert BadBatch();
    }

    function _post(bytes32 room, bytes calldata wire) private {
        if (wire.length == 0) revert EmptyWire();
        if (wire.length > MAX_WIRE) revert WireTooLarge(wire.length);
        emit Wire(room, wire);
    }
}

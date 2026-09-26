// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ChannelBus} from "../src/ChannelBus.sol";

contract ChannelBusTest is Test {
    event Wire(bytes32 indexed room, bytes wire);

    ChannelBus bus;

    function setUp() public {
        bus = new ChannelBus();
    }

    function testFuzz_sendEmitsWire(bytes32 room, bytes calldata wire, address sender) public {
        vm.assume(wire.length > 0 && wire.length <= bus.MAX_WIRE());
        vm.expectEmit(true, false, false, true, address(bus));
        emit Wire(room, wire);
        vm.prank(sender);
        bus.send(room, wire);
    }

    function test_sendRejectsEmptyAndOversize() public {
        vm.expectRevert(ChannelBus.EmptyWire.selector);
        bus.send(bytes32(0), "");
        uint256 max = bus.MAX_WIRE();
        bus.send(bytes32(0), new bytes(max));
        vm.expectRevert(abi.encodeWithSelector(ChannelBus.WireTooLarge.selector, max + 1));
        bus.send(bytes32(0), new bytes(max + 1));
    }

    function _pack(bytes[] memory wires) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < wires.length; i++) out = bytes.concat(out, bytes2(uint16(wires[i].length)), wires[i]);
    }

    function testFuzz_sendManyEmitsEachInOrder(bytes32 room, uint8 count, uint256 seed) public {
        uint256 n = bound(count, 1, bus.MAX_BATCH());
        bytes[] memory wires = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            wires[i] = abi.encodePacked(keccak256(abi.encode(seed, i)));
            if (i % 3 == 1) wires[i] = bytes.concat(wires[i], wires[i], hex"01");   // mixed lengths / 长度不一
        }
        vm.recordLogs();
        bus.sendMany(room, _pack(wires));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, n);
        for (uint256 i = 0; i < n; i++) {
            assertEq(logs[i].topics[0], Wire.selector);
            assertEq(logs[i].topics[1], room);
            assertEq(abi.decode(logs[i].data, (bytes)), wires[i]);
        }
    }

    function test_sendManyRejectsMalformedBatches() public {
        vm.expectRevert(ChannelBus.BadBatch.selector);
        bus.sendMany(bytes32(0), "");                               // nothing / 空
        vm.expectRevert(ChannelBus.BadBatch.selector);
        bus.sendMany(bytes32(0), hex"00");                          // half a length / 半个长度
        vm.expectRevert(ChannelBus.BadBatch.selector);
        bus.sendMany(bytes32(0), hex"0005010203");                  // length past the end / 长度越界
        vm.expectRevert(ChannelBus.EmptyWire.selector);
        bus.sendMany(bytes32(0), hex"0000");                        // an empty wire / 空消息
        bytes[] memory many = new bytes[](bus.MAX_BATCH() + 1);
        for (uint256 i = 0; i < many.length; i++) many[i] = hex"01";
        vm.expectRevert(ChannelBus.BadBatch.selector);
        bus.sendMany(bytes32(0), _pack(many));                      // too many / 太多
    }

    function test_storesNothingAndRefusesValue() public {
        vm.record();
        bus.send(bytes32(uint256(1)), hex"010203");
        (, bytes32[] memory writes) = vm.accesses(address(bus));
        assertEq(writes.length, 0);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(bus).call{value: 1}(abi.encodeCall(ChannelBus.send, (bytes32(0), hex"01")));
        assertFalse(ok, "value is refused");
        (ok,) = address(bus).call{value: 1}("");
        assertFalse(ok, "no receive");
    }

    function test_selectorsAndTopic() public pure {
        assertEq(ChannelBus.send.selector, bytes4(keccak256("send(bytes32,bytes)")));
        assertEq(ChannelBus.sendMany.selector, bytes4(keccak256("sendMany(bytes32,bytes)")));
        assertEq(Wire.selector, keccak256("Wire(bytes32,bytes)"));
    }
}

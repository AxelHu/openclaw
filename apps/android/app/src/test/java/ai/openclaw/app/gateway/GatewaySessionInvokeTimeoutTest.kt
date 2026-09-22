package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewaySessionInvokeTimeoutTest {
  @Test
  fun formatGatewayAuthority_bracketsIpv6Hosts() {
    assertEquals("[::1]:18789", formatGatewayAuthority("::1", 18_789))
  }

  @Test
  fun buildGatewayWebSocketUrl_bracketsIpv6Hosts() {
    assertEquals("ws://[::1]:18789", buildGatewayWebSocketUrl("::1", 18_789, useTls = false))
    assertEquals("wss://[::1]:443", buildGatewayWebSocketUrl("::1", 443, useTls = true))
  }

  @Test
  fun buildGatewayWebSocketUrl_normalizesPersistedBracketedIpv6Hosts() {
    assertEquals("ws://[::1]:18789", buildGatewayWebSocketUrl("[::1]", 18_789, useTls = false))
    assertEquals("wss://[::1]:443", buildGatewayWebSocketUrl("[::1]", 443, useTls = true))
  }

  @Test
  fun buildGatewayWebSocketUrl_preservesAndEncodesContextPath() {
    assertEquals(
      "wss://gateway.example:443/openclaw%20gateway",
      buildGatewayWebSocketUrl(
        host = "gateway.example",
        port = 443,
        useTls = true,
        contextPath = "/openclaw%20gateway",
      ),
    )
    assertEquals(
      "wss://gateway.example:443/openclaw%2Fgateway",
      buildGatewayWebSocketUrl(
        host = "gateway.example",
        port = 443,
        useTls = true,
        contextPath = "/openclaw%2Fgateway",
      ),
    )
    assertEquals(
      "wss://gateway.example:443//openclaw",
      buildGatewayWebSocketUrl(
        host = "gateway.example",
        port = 443,
        useTls = true,
        contextPath = "//openclaw",
      ),
    )
  }

  @Test
  fun shouldBypassSystemProxyForGatewayHost_bypassesLoopbackAndPrivateLiterals() {
    listOf(
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.94",
      "169.254.10.20",
      "::1",
      "[fd12:3456::1]",
      "fe80::1234%wlan0",
      "::ffff:192.168.1.10",
    ).forEach { host -> assertTrue(host, shouldBypassSystemProxyForGatewayHost(host)) }
  }

  @Test
  fun shouldBypassSystemProxyForGatewayHost_keepsPublicAndNamedHostsOnSystemProxy() {
    listOf(
      "gateway.example",
      "8.8.8.8",
      "100.64.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "2001:4860:4860::8888",
    ).forEach { host -> assertFalse(host, shouldBypassSystemProxyForGatewayHost(host)) }
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_usesFloorWhenMissingOrTooSmall() {
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(null))
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(0L))
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(5_000L))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_usesInvokeBudgetWithinBounds() {
    assertEquals(30_000L, resolveInvokeResultAckTimeoutMs(30_000L))
    assertEquals(90_000L, resolveInvokeResultAckTimeoutMs(90_000L))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_capsAtUpperBound() {
    assertEquals(120_000L, resolveInvokeResultAckTimeoutMs(121_000L))
    assertEquals(120_000L, resolveInvokeResultAckTimeoutMs(Long.MAX_VALUE))
  }

  @Test
  fun resolveInvokeExecutionTimeoutMs_defaultsAndAllowsExplicitDisable() {
    assertEquals(30_000L, resolveInvokeExecutionTimeoutMs(null))
    assertEquals(null, resolveInvokeExecutionTimeoutMs(0L))
    assertEquals(null, resolveInvokeExecutionTimeoutMs(-1L))
  }

  @Test
  fun resolveInvokeExecutionTimeoutMs_capsAtCoroutineTimerBound() {
    assertEquals(Int.MAX_VALUE.toLong(), resolveInvokeExecutionTimeoutMs(Long.MAX_VALUE))
  }
}

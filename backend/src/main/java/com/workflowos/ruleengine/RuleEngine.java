package com.workflowos.ruleengine;

import static com.workflowos.common.Errors.require;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.*;
import java.util.*;

/** Bounded JSON interpreter: no reflection, scripts, or arbitrary code. */
public final class RuleEngine {
  private RuleEngine() {}

  public static BigDecimal number(JsonNode n, Map<String, BigDecimal> vars) {
    return number(n, vars, 0);
  }

  private static BigDecimal number(JsonNode n, Map<String, BigDecimal> vars, int depth) {
    require(depth < 24 && n != null, "表达式过深或缺失");
    if (n.isNumber()) return bounded(n.decimalValue());
    if (n.has("var")) {
      String key = n.get("var").asText();
      require(vars.containsKey(key), "缺少业务变量：" + key);
      return bounded(vars.get(key));
    }
    require(n.has("op") && n.has("left") && n.has("right"), "无效的算术表达式");
    BigDecimal a = number(n.get("left"), vars, depth + 1),
        b = number(n.get("right"), vars, depth + 1);
    return bounded(
        switch (n.get("op").asText()) {
          case "+" -> a.add(b);
          case "-" -> a.subtract(b);
          case "*" -> a.multiply(b);
          case "/" -> {
            require(b.signum() != 0, "规则不能除以零");
            yield a.divide(b, 12, RoundingMode.HALF_UP);
          }
          default -> throw new IllegalArgumentException("不支持的运算符");
        });
  }

  private static BigDecimal bounded(BigDecimal n) {
    require(
        n != null
            && n.precision() < 30
            && Math.abs(n.scale()) < 30
            && n.abs().compareTo(new BigDecimal("1000000000000")) <= 0,
        "数值超出范围");
    return n;
  }

  public static boolean matches(JsonNode n, Map<String, BigDecimal> vars) {
    return matches(n, vars, 0);
  }

  private static boolean matches(JsonNode n, Map<String, BigDecimal> vars, int depth) {
    require(n != null && depth < 24, "条件过深或缺失");
    if (n.isBoolean()) return n.booleanValue();
    String op = n.path("op").asText();
    if (op.equals("AND") || op.equals("OR")) {
      JsonNode children = n.path("conditions");
      require(children.isArray() && !children.isEmpty() && children.size() <= 50, "条件列表无效");
      boolean result = op.equals("AND");
      for (JsonNode c : children) {
        boolean v = matches(c, vars, depth + 1);
        result = op.equals("AND") ? result && v : result || v;
      }
      return result;
    }
    int c = number(n.get("left"), vars).compareTo(number(n.get("right"), vars));
    return switch (op) {
      case ">" -> c > 0;
      case ">=" -> c >= 0;
      case "<" -> c < 0;
      case "<=" -> c <= 0;
      case "==" -> c == 0;
      case "!=" -> c != 0;
      default -> throw new IllegalArgumentException("不支持的比较符");
    };
  }

  public static BigDecimal quantity(JsonNode action, Map<String, BigDecimal> vars) {
    BigDecimal result = number(action.get("expression"), vars);
    require(result.signum() >= 0, "工作量不能为负数");
    BigDecimal step =
        action.has("increment") ? number(action.get("increment"), vars) : new BigDecimal("0.01");
    require(step.signum() > 0, "最小单位必须大于零");
    RoundingMode mode =
        switch (action.path("rounding").asText("UP")) {
          case "UP" -> RoundingMode.CEILING;
          case "DOWN" -> RoundingMode.FLOOR;
          case "NEAREST" -> RoundingMode.HALF_UP;
          default -> throw new IllegalArgumentException("无效舍入规则");
        };
    return result.divide(step, 0, mode).multiply(step).setScale(2, RoundingMode.UNNECESSARY);
  }
}

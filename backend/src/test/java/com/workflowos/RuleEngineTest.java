package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workflowos.ruleengine.RuleEngine;
import java.math.BigDecimal;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RuleEngineTest {
  ObjectMapper j = new ObjectMapper();

  @Test
  void decimalCalculationAndRounding() throws Exception {
    var action =
        j.readTree(
            """
{"expression":{"op":"*","left":{"op":"*","left":{"var":"guests"},"right":0.15},"right":1.1},"increment":0.1,"rounding":"UP"}
""");
    assertEquals(
        new BigDecimal("16.50"),
        RuleEngine.quantity(action, Map.of("guests", new BigDecimal("100"))));
    assertEquals(
        new BigDecimal("16.70"),
        RuleEngine.quantity(action, Map.of("guests", new BigDecimal("101"))));
  }

  @Test
  void allConditionsValidatedEvenInOr() throws Exception {
    var n =
        j.readTree(
            "{\"op\":\"OR\",\"conditions\":[true,{\"op\":\">\",\"left\":{\"var\":\"missing\"},\"right\":0}]}");
    assertThrows(RuntimeException.class, () -> RuleEngine.matches(n, Map.of()));
  }

  @Test
  void rejectsUnknownOperatorsAndDivisionByZero() throws Exception {
    var n = j.readTree("{\"op\":\"/\",\"left\":1,\"right\":0}");
    assertThrows(RuntimeException.class, () -> RuleEngine.number(n, Map.of()));
    var code = j.readTree("{\"op\":\"eval\",\"left\":1,\"right\":2}");
    assertThrows(RuntimeException.class, () -> RuleEngine.number(code, Map.of()));
  }

  @Test
  void boundsDepth() throws Exception {
    String s = "1";
    for (int i = 0; i < 30; i++) s = "{\"op\":\"+\",\"left\":" + s + ",\"right\":1}";
    var n = j.readTree(s);
    assertThrows(RuntimeException.class, () -> RuleEngine.number(n, Map.of()));
  }
}

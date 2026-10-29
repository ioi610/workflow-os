package com.workflowos.auth;

import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {
  @Bean
  BCryptPasswordEncoder encoder() {
    return new BCryptPasswordEncoder();
  }

  @Bean
  SecurityFilterChain chain(HttpSecurity http) throws Exception {
    // Session user and tenant permissions are checked by Access on every business route.
    return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
        .csrf(c -> {})
        .headers(h -> h.contentTypeOptions(c -> {}).frameOptions(f -> f.deny()))
        .build();
  }
}

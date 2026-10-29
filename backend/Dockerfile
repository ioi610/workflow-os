FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src src
RUN mvn -q package -DskipTests
FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S workflow && adduser -S workflow -G workflow
WORKDIR /app
RUN mkdir -p /app/.data && chown -R workflow:workflow /app/.data
COPY --from=build /app/target/workflow-os-0.1.0.jar app.jar
USER workflow
EXPOSE 8080
ENTRYPOINT ["java","-jar","app.jar"]

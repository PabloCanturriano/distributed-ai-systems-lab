#!/usr/bin/env bash
set -euo pipefail
trap 'echo "{\"event\":\"kafka_topics_failed\"}" >&2' ERR
if [[ $# -ne 0 || "${APP_MODE-local}" != "local" ]]; then
  echo '{"event":"kafka_topics_failed"}' >&2
  exit 1
fi
export KAFKA_HEAP_OPTS='-Xms32m -Xmx128m'
for topic in tickets.execution-requested.v1 tickets.execution-failed.v1; do
  timeout 30 /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:9092 --command-config /opt/lab/admin.properties \
    --create --if-not-exists --topic "$topic" --partitions 3 --replication-factor 1 \
    --config cleanup.policy=delete --config retention.ms=604800000 \
    --config min.insync.replicas=1 >/dev/null 2>&1
  description=$(timeout 30 /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:9092 --command-config /opt/lab/admin.properties \
    --describe --topic "$topic" 2>/dev/null)
  [[ "$description" =~ PartitionCount:[[:space:]]+3[[:space:]] ]]
  [[ "$description" =~ ReplicationFactor:[[:space:]]+1[[:space:]] ]]
  configuration=$(timeout 30 /opt/kafka/bin/kafka-configs.sh \
    --bootstrap-server kafka:9092 --command-config /opt/lab/admin.properties \
    --entity-type topics --entity-name "$topic" --describe --all 2>/dev/null)
  # Match complete property values, not a prefix such as delete,compact.
  [[ "$configuration" =~ [[:space:]]cleanup\.policy=delete([[:space:]]|$) ]]
  [[ "$configuration" =~ [[:space:]]retention\.ms=604800000([[:space:]]|$) ]]
  [[ "$configuration" =~ [[:space:]]min\.insync\.replicas=1([[:space:]]|$) ]]
done
echo '{"event":"kafka_topics_complete","topics":2}'

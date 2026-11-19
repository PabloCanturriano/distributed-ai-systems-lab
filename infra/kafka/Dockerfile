# Bootstrap tools use the pinned broker distribution and its non-root user.
FROM apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f
COPY infra/kafka/init-topics.sh /opt/lab/init-topics.sh
COPY infra/kafka/admin.properties /opt/lab/admin.properties
ENTRYPOINT ["/bin/bash", "/opt/lab/init-topics.sh"]

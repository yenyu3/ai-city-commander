FROM public.ecr.aws/lambda/python:3.12

# Build context is backend/service/ (the parent of this file's own
# directory) -- see compute.tf's docker buildx invocation -- so this
# Dockerfile can reach the shared modules every per-service Lambda needs.
COPY requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install -r ${LAMBDA_TASK_ROOT}/requirements.txt --target "${LAMBDA_TASK_ROOT}"

COPY db.py s3_cache.py s3_common.py decision_routing.py api_common.py worker_invoke.py ${LAMBDA_TASK_ROOT}/
COPY agent/ ${LAMBDA_TASK_ROOT}/agent/
COPY rules/ ${LAMBDA_TASK_ROOT}/rules/
COPY chat/handler.py ${LAMBDA_TASK_ROOT}/handler.py

CMD ["handler.handler"]

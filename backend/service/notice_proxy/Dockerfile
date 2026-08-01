FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install -r ${LAMBDA_TASK_ROOT}/requirements.txt --target "${LAMBDA_TASK_ROOT}"

COPY db.py s3_cache.py s3_common.py decision_routing.py api_common.py worker_invoke.py report_builder.py ${LAMBDA_TASK_ROOT}/
COPY agent/ ${LAMBDA_TASK_ROOT}/agent/
COPY rules/ ${LAMBDA_TASK_ROOT}/rules/
COPY notice_proxy/handler.py ${LAMBDA_TASK_ROOT}/handler.py

CMD ["handler.handler"]

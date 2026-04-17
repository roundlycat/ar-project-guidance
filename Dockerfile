# Use the official Python base image
FROM python:3.11-slim

# Set the working directory inside the container
WORKDIR /app

# Install system-level dependencies securely (bypassing the need for .venv)
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy the requirements file and install pip dependencies globally inside the sandbox
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the entire ar-project-guidance source code into the container
COPY . .

# Expose the specific port Uvicorn will broadcast on
EXPOSE 9500

# The automated startup command (No manual SSH intervention required)
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9500"]

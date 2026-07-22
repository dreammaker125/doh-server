FROM coredns/coredns:latest
COPY Corefile /Corefile
EXPOSE 8080
CMD ["-conf", "/Corefile"]

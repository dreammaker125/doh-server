FROM coredns/coredns:1.11.1
COPY Corefile /Corefile
EXPOSE 8080
CMD ["-conf", "/Corefile"]

# A Raspberry Pi Imager repository holding only seedypod OS, offered only on the boards
# it runs on, so the wrong OS for a Pi Zero W can't be picked. `init_format` is what
# turns on Imager's customisation (login, Wi-Fi, hostname) for this image.
{
  imager: {
    devices: [
      {
        name: "Raspberry Pi Zero W",
        tags: ["pi1-32bit"],
        icon: "https://downloads.raspberrypi.com/imager/icons/RPi_Zero.png",
        description: "The board in a Gardyn unit",
        matching_type: "inclusive",
        capabilities: []
      },
      {
        name: "Raspberry Pi Zero 2 W",
        tags: ["pi3-32bit"],
        icon: "https://downloads.raspberrypi.com/imager/icons/RPi_Zero_2_W.png",
        description: "The drop-in upgrade",
        matching_type: "inclusive",
        capabilities: []
      }
    ]
  },
  os_list: [
    {
      name: "seedypod OS",
      description: "Raspberry Pi OS Lite (32-bit) with hald and core installed (\($branch) \($commit))",
      icon: $icon,
      url: $url,
      extract_size: $extract_size,
      extract_sha256: $extract_sha256,
      image_download_size: $download_size,
      image_download_sha256: $download_sha256,
      release_date: $date,
      init_format: "cloudinit-rpi",
      devices: ["pi1-32bit", "pi3-32bit"],
      capabilities: []
    }
  ]
}
